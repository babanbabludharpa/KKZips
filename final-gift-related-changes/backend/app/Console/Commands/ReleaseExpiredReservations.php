<?php

namespace App\Console\Commands;

use App\Models\Inventory;
use App\Models\Tenant\Order;
use App\Services\V1\Orders\GiftService;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;

class ReleaseExpiredReservations extends Command
{
    public function __construct(protected GiftService $gifts)
    {
        parent::__construct();
    }

    protected $signature = 'orders:release-expired-reservations';

    protected $description = 'Release stock reservations for orders stuck in pending_payment past the timeout, and mark them expired.';

    // Timeout hardcoded rather than a CLI option — tenants:run does not
    // reliably forward custom options through to the wrapped command.
    // Change this value directly if the timeout needs adjusting.
    private const TIMEOUT_MINUTES = 15;

    public function handle(): int
    {
        $cutoff = now()->subMinutes(self::TIMEOUT_MINUTES);

        // Only pending_payment — never touch confirmed/cod orders, and
        // never touch orders newer than the cutoff (still legitimately
        // mid-checkout).
        $expiredOrders = Order::where('status', 'pending_payment')
            ->where('created_at', '<', $cutoff)
            ->with('items')
            ->get();

        if ($expiredOrders->isEmpty()) {
            $this->info('No expired reservations to release.');

            return self::SUCCESS;
        }

        foreach ($expiredOrders as $order) {
            DB::transaction(function () use ($order) {
                foreach ($order->items as $item) {
                    // Release exactly this order's reserved quantity —
                    // never blanket-zero the column, which would wipe
                    // out other orders' concurrent legitimate reservations
                    // on the same inventory row.
                    Inventory::where('product_variant_id', $item->product_variant_id)
                        ->where('branch_id', $order->branch_id)
                        ->lockForUpdate()
                        ->decrement('quantity_reserved', $item->quantity);
                }

                // ★ FREE GIFTS — the gift lines reserved above were recorded
                // as a usage at placement. This order never completed, so the
                // gift usage must be released too, otherwise the campaign's
                // total cap and the customer's per-customer cap are burnt by
                // orders that were never paid for.
                $this->gifts->releaseUsageForOrder($order);

                $order->update([
                    'status' => 'expired',
                    'payment_status' => 'failed',
                ]);
            });

            $this->info("Released reservation and expired order #{$order->id}");
        }

        return self::SUCCESS;
    }
}
