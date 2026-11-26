<?php

namespace App\Http\Controllers\Api\V1\Mobile;

use App\Exceptions\InsufficientWalletBalanceException;
use App\Http\Controllers\Controller;
use App\Models\TenantDeliverySlot;
use App\Services\V1\Orders\OrderSlotPolicyService;
use App\Services\V1\Orders\CouponService;
use App\Services\V1\Orders\GiftService;
use App\Services\V1\Orders\InvoicePdfService;
use App\Services\V1\Orders\OrderService;
use App\Services\V1\Orders\RazorpayService;
use App\Services\V1\Tenant\TenantProfileService;
use App\Services\V1\Wallet\WalletService;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Storage;

class OrderController extends Controller
{
    private const MSG_COD_UNAVAILABLE = 'Cash on Delivery is not available. Please choose online payment.';

    private const MSG_ONLINE_UNAVAILABLE = 'Online payment is not available. Please choose Cash on Delivery.';

    private const MSG_RAZORPAY_NOT_CONFIGURED = 'Online payment is not set up yet for this store. Please choose Cash on Delivery or contact support.';

    private const MSG_WALLET_INSUFFICIENT = 'Insufficient wallet balance. Please top up your wallet and try again.';

    private const MSG_NO_PAYMENT_INITIATED = 'No payment initiated.';

    private const MSG_PAYMENT_VERIFICATION_FAILED = 'Payment verification failed.';

    private const MSG_SLOT_REQUIRED = 'Please select a delivery slot before placing this order.';

    private const MSG_SLOT_STALE = 'The selected delivery slot is no longer available. Please pick another slot.';

    public function __construct(
        protected OrderService $orderService,
        protected GiftService $giftService,
        protected RazorpayService $razorpayService,
        protected CouponService $couponService,
        protected TenantProfileService $tenantProfileService,
        protected InvoicePdfService $invoicePdf,
        protected WalletService $walletService,
        protected OrderSlotPolicyService $slotPolicy,
    ) {}

    public function downloadInvoice(Request $request, $orderId)
    {
        $order = $request->user()->orders()
            ->with(['items.variant.product', 'branch', 'customer'])
            ->findOrFail($orderId);

        return $this->invoicePdf->build($order)
            ->stream('invoice-'.($order->order_number ?? $order->id).'.pdf');
    }

    /**
     * Checkout context — the mobile app calls this before rendering
     * the cart/checkout screen. It tells the app whether a slot picker
     * is required, and returns the bookable slots for the next N days.
     */
    public function checkoutContext(Request $request): JsonResponse
    {
        $profile = $this->tenantProfileService->getProfile();
        $now = CarbonImmutable::now();

        return response()->json([
            'status' => true,
            'data' => [
                'use_order_slots'    => $this->slotPolicy->orderSlotsRequired(),
                'order_start_policy' => $profile?->order_start_policy ?? 'next_day_only',
                'slots'              => $this->slotPolicy->availableOrderSlots($now),
            ],
        ]);
    }

    public function preview(Request $request): JsonResponse
    {
        $request->validate([
            'lat' => 'required|numeric',
            'lng' => 'required|numeric',
            'items' => 'required|array|min:1',
            'items.*.variant_id' => 'required|integer|exists:product_variants,id',
            'items.*.quantity' => 'required|integer|min:1',
            'coupon_code' => 'nullable|string',
        ]);

        $preview = $this->orderService->preview($request->all(), $request->user());

        return response()->json(['status' => true, 'data' => $preview]);
    }

    public function store(Request $request): JsonResponse
    {
        // ── Base rules (unchanged) ────────────────────────────
        $rules = [
            'lat' => 'required|numeric',
            'lng' => 'required|numeric',
            'items' => 'required|array|min:1',
            'items.*.variant_id' => 'required|integer|exists:product_variants,id',
            'items.*.quantity' => 'required|integer|min:1',
            'payment_mode' => 'required|in:cod,online,wallet',
            'delivery_address' => 'required|array',
            'delivery_address.name' => 'required|string',
            'delivery_address.phone' => 'required|string',
            'delivery_address.line1' => 'required|string',
            'delivery_address.city' => 'required|string',
            'delivery_address.pincode' => 'required|string',
            'delivery_address.lat' => 'required|numeric',
            'delivery_address.lng' => 'required|numeric',
            'coupon_code' => 'nullable|string',
            'customer_remark' => 'nullable|string|max:255',
        ];

        // ── Slot rules — conditional on tenant flag ───────────
        $slotsRequired = $this->slotPolicy->orderSlotsRequired();
        if ($slotsRequired) {
            $rules['delivery_slot_id'] = 'required|integer|exists:tenant_delivery_slots,id';
            $rules['delivery_date']    = 'required|date_format:Y-m-d';
        } else {
            $rules['delivery_slot_id'] = 'prohibited';
            $rules['delivery_date']    = 'nullable|date_format:Y-m-d';
        }

        $data = $request->validate($rules);

        // ── Bookability check (only when slots are required) ─
        if ($slotsRequired) {
            $profile = $this->tenantProfileService->getProfile();
            $now     = CarbonImmutable::now();
            $slot    = TenantDeliverySlot::findOrFail($data['delivery_slot_id']);
            $date    = CarbonImmutable::createFromFormat('Y-m-d', $data['delivery_date']);

            if (! $this->slotPolicy->isOrderSlotBookable($profile, $slot, $date, $now)) {
                return $this->errorResponse(self::MSG_SLOT_STALE, 422);
            }

            // Snapshot for historical accuracy.
            $data['uses_slot_at_checkout'] = true;
        } else {
            unset($data['delivery_slot_id'], $data['delivery_date']);
        }

        // ── Existing payment mode guard ──────────────────────
        if ($error = $this->paymentModeGuard($data['payment_mode'])) {
            return $error;
        }

        try {
            if ($data['payment_mode'] === 'wallet') {
                $order = $this->placeWalletOrder($data, $request->user());
            } else {
                $order = $this->orderService->place($data, $request->user());
            }
        } catch (InsufficientWalletBalanceException $e) {
            return $this->errorResponse($e->getMessage(), 422);
        }

        return $this->orderPlacedResponse($order, $data['payment_mode']);
    }

    /**
     * Wallet orders are placed and paid atomically.
     */
    private function placeWalletOrder(array $payload, $customer)
    {
        return DB::transaction(function () use ($payload, $customer) {
            $order = $this->orderService->place($payload, $customer);

            $wallet = DB::table('customer_wallets')
                ->where('customer_id', $customer->id)
                ->lockForUpdate()
                ->first();

            $balance = $wallet ? (float) $wallet->balance : 0.0;
            $total = (float) $order->total;

            if ($balance < $total) {
                throw new InsufficientWalletBalanceException(
                    required: $total,
                    available: $balance,
                    message: sprintf(
                        'Insufficient wallet balance. You need ₹%s more. Current balance: ₹%s.',
                        number_format($total - $balance, 2),
                        number_format($balance, 2)
                    )
                );
            }

            $this->walletService->debit(
                customerId: $customer->id,
                amount: $total,
                type: 'order_payment',
                referenceType: 'order',
                referenceId: $order->id,
                remark: 'Payment for order #'.($order->order_number ?? $order->id),
                addedBy: null,
            );

            $order->update([
                'payment_status' => 'paid',
                'status' => 'confirmed',
            ]);

            $this->orderService->confirmStock($order);

            return $order->fresh();
        });
    }

    private function orderPlacedResponse($order, string $paymentMode): JsonResponse
    {
        $response = [
            'order_id' => $order->id,
            'order_number' => $order->order_number,
            'status' => $order->status,
            'payment_mode' => $order->payment_mode,
            'total' => $order->total,
        ];

        if ($paymentMode === 'online') {
            $response['razorpay'] = $this->razorpayService->createOrder($order);
        }

        if ($paymentMode === 'wallet') {
            $response['paid'] = true;
        }

        return response()->json(['status' => true, 'data' => $response], 201);
    }

    private function paymentModeGuard(string $paymentMode): ?JsonResponse
    {
        return match ($paymentMode) {
            'cod' => $this->codGuard(),
            'online' => $this->onlineGuard(),
            'wallet' => $this->walletGuard(),
            default => $this->errorResponse('Invalid payment mode.', 422),
        };
    }

    private function codGuard(): ?JsonResponse
    {
        $profile = $this->tenantProfileService->getProfile();
        $codEnabled = $profile ? (bool) $profile->cod_enabled : false;

        return $codEnabled ? null : $this->errorResponse(self::MSG_COD_UNAVAILABLE, 422);
    }

    private function onlineGuard(): ?JsonResponse
    {
        $profile = $this->tenantProfileService->getProfile();
        $onlineEnabled = $profile ? (bool) $profile->online_payment_enabled : true;

        if (! $onlineEnabled) {
            return $this->errorResponse(self::MSG_ONLINE_UNAVAILABLE, 422);
        }

        if (! $this->tenantProfileService->razorpayIsConfigured()) {
            return $this->errorResponse(self::MSG_RAZORPAY_NOT_CONFIGURED, 422);
        }

        return null;
    }

    private function walletGuard(): ?JsonResponse
    {
        return null;
    }

    public function verifyPayment(Request $request, $orderId): JsonResponse
    {
        $request->validate([
            'razorpay_payment_id' => 'required|string',
            'razorpay_signature' => 'required|string',
        ]);

        $order = $request->user()->orders()->findOrFail($orderId);

        if (! $order->razorpay_order_id) {
            return $this->errorResponse(self::MSG_NO_PAYMENT_INITIATED, 422);
        }

        $valid = $this->razorpayService->verifySignature(
            $order->razorpay_order_id,
            $request->razorpay_payment_id,
            $request->razorpay_signature
        );

        if (! $valid) {
            return $this->handleFailedVerification($order, $request);
        }

        $order->update([
            'razorpay_payment_id' => $request->razorpay_payment_id,
            'razorpay_signature' => $request->razorpay_signature,
            'payment_status' => 'paid',
            'status' => 'confirmed',
        ]);

        $this->orderService->confirmStock($order);

        return response()->json(['status' => true, 'message' => 'Payment verified. Order confirmed.']);
    }

    private function handleFailedVerification($order, Request $request): JsonResponse
    {
        Log::warning('Razorpay signature mismatch', [
            'order_id' => $order->id,
            'razorpay_order_id' => $order->razorpay_order_id,
            'payment_id' => $request->razorpay_payment_id,
            'key_id_used' => $this->razorpayService->getKeyIdForDebug(),
        ]);

        $order->update(['payment_status' => 'failed', 'status' => 'payment_failed']);
        $this->orderService->releaseStock($order);

        // ★ FREE GIFTS — payment never succeeded, so the gift usage recorded
        // at placement must be released as well (stock was just released
        // above; this undoes the campaign/customer cap accounting).
        $this->giftService->releaseUsageForOrder($order);

        return $this->errorResponse(self::MSG_PAYMENT_VERIFICATION_FAILED, 422);
    }

    public function webhook(Request $request): JsonResponse
    {
        $webhookSecret = config('services.razorpay.webhook_secret');

        if ($webhookSecret) {
            $signature = $request->header('X-Razorpay-Signature');
            $expected = hash_hmac('sha256', $request->getContent(), $webhookSecret);
            if (! hash_equals($expected, $signature ?? '')) {
                return response()->json(['status' => false], 400);
            }
        }

        $this->razorpayService->handleWebhook($request->all());

        return response()->json(['status' => true]);
    }

    public function index(Request $request): JsonResponse
    {
        $orders = $request->user()->orders()
            ->with(['items.variant.product', 'branch'])
            ->orderByDesc('created_at')
            ->paginate(20);

        return response()->json(['status' => true, 'data' => $orders]);
    }

    public function show(Request $request, $orderId): JsonResponse
    {
        $order = $request->user()->orders()
            ->with(['items.variant.product', 'branch', 'deliveryBoy'])
            ->findOrFail($orderId);

        $payload = $order->toArray();
        $payload['delivery_photo_url'] = $order->delivery_photo_path
            ? Storage::disk('public')->url($order->delivery_photo_path)
            : null;

        return response()->json(['status' => true, 'data' => $payload]);
    }

    public function validateCoupon(Request $request): JsonResponse
    {
        $request->validate([
            'code' => 'required|string',
            'subtotal' => 'required|numeric|min:0',
        ]);

        $result = $this->couponService->validate(
            $request->code,
            $request->subtotal,
            $request->user()
        );

        return response()->json(['status' => true, 'data' => $result]);
    }

    private function errorResponse(string $message, int $status): JsonResponse
    {
        return response()->json([
            'status' => false,
            'message' => $message,
        ], $status);
    }
}
