<?php

namespace App\Http\Controllers\Api\V1\Masters;

use App\Http\Controllers\Controller;
use App\Http\Resources\V1\GiftCampaignResource;
use App\Models\GiftCampaign;
use App\Models\ProductVariant;
use App\Services\V1\Masters\GiftCampaignService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * ★ FREE GIFTS — admin API.
 *
 * Everything here sits behind the gift.* permissions (see routes).
 * Gift product mutations only ever go through this controller — the
 * normal product/variant endpoints reject gift variants outright.
 */
class GiftController extends Controller
{
    public function __construct(protected GiftCampaignService $service) {}

    // ── Campaigns ───────────────────────────────────────────────────

    public function index(Request $request): JsonResponse
    {
        $request->validate([
            'search' => 'nullable|string|max:255',
            'is_active' => 'nullable|boolean',
            'per_page' => 'nullable|integer|min:10|max:100',
        ]);

        $campaigns = $this->service->getAll(
            $request->only(['search', 'is_active', 'per_page'])
        );

        return response()->json([
            'status' => true,
            'message' => 'Gift campaigns retrieved.',
            'data' => [
                'data' => GiftCampaignResource::collection($campaigns->items()),
                'meta' => [
                    'current_page' => $campaigns->currentPage(),
                    'last_page' => $campaigns->lastPage(),
                    'per_page' => $campaigns->perPage(),
                    'total' => $campaigns->total(),
                    'from' => $campaigns->firstItem(),
                    'to' => $campaigns->lastItem(),
                ],
            ],
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate($this->campaignRules());

        $campaign = $this->service->create($validated);

        return response()->json([
            'status' => true,
            'message' => 'Gift campaign created.',
            'data' => ['campaign' => new GiftCampaignResource($campaign)],
        ], 201);
    }

    public function show(GiftCampaign $campaign): JsonResponse
    {
        $campaign = $this->service->findById($campaign->id);

        return response()->json([
            'status' => true,
            'message' => 'Gift campaign retrieved.',
            'data' => ['campaign' => new GiftCampaignResource($campaign)],
        ]);
    }

    public function update(Request $request, GiftCampaign $campaign): JsonResponse
    {
        $validated = $request->validate($this->campaignRules(required: false));

        $campaign = $this->service->update($campaign, $validated);

        return response()->json([
            'status' => true,
            'message' => 'Gift campaign updated.',
            'data' => ['campaign' => new GiftCampaignResource($campaign)],
        ]);
    }

    public function toggle(GiftCampaign $campaign): JsonResponse
    {
        $campaign = $this->service->toggle($campaign);

        return response()->json([
            'status' => true,
            'message' => $campaign->is_active
                ? 'Gift campaign activated. Any other campaign was deactivated.'
                : 'Gift campaign deactivated.',
            'data' => ['campaign' => new GiftCampaignResource($campaign)],
        ]);
    }

    public function destroy(GiftCampaign $campaign): JsonResponse
    {
        $this->service->delete($campaign);

        return response()->json([
            'status' => true,
            'message' => 'Gift campaign deleted.',
            'data' => [],
        ]);
    }

    // ── Gift products ───────────────────────────────────────────────

    public function giftProducts(Request $request): JsonResponse
    {
        $request->validate([
            'search' => 'nullable|string|max:255',
            'is_active' => 'nullable|boolean',
            'per_page' => 'nullable|integer|min:10|max:100',
        ]);

        $variants = $this->service->giftProducts(
            $request->only(['search', 'is_active', 'per_page'])
        );

        return response()->json([
            'status' => true,
            'message' => 'Gift products retrieved.',
            'data' => [
                'data' => collect($variants->items())->map(fn ($v) => $this->formatGiftProduct($v)),
                'meta' => [
                    'current_page' => $variants->currentPage(),
                    'last_page' => $variants->lastPage(),
                    'per_page' => $variants->perPage(),
                    'total' => $variants->total(),
                ],
            ],
        ]);
    }

    public function storeGiftProduct(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'name' => ['required', 'string', 'max:150'],
            'description' => ['nullable', 'string'],
            'category_id' => ['nullable', 'integer', 'exists:categories,id'],
            'sku' => ['required', 'string', 'max:60'],
            'unit_id' => ['required', 'integer', 'exists:units,id'],
            'hsn_code' => ['nullable', 'string', 'max:20'],
            'mrp' => ['required', 'numeric', 'min:0'],
            'purchase_price' => ['nullable', 'numeric', 'min:0'],
            'tax_rate_id' => ['nullable', 'integer', 'exists:tax_rates,id'],
            'image' => ['nullable', 'image', 'mimes:jpeg,png,jpg,webp', 'max:2048'],
        ]);

        $variant = $this->service->createGiftProduct(
            $validated,
            $request->file('image')
        );

        return response()->json([
            'status' => true,
            'message' => 'Gift product created. Remember to inward its stock and add it to a campaign tier.',
            'data' => ['gift_product' => $this->formatGiftProduct($variant)],
        ], 201);
    }

    public function updateGiftProduct(Request $request, ProductVariant $variant): JsonResponse
    {
        $validated = $request->validate([
            'name' => ['sometimes', 'string', 'max:150'],
            'description' => ['nullable', 'string'],
            'sku' => ['sometimes', 'string', 'max:60'],
            'unit_id' => ['sometimes', 'integer', 'exists:units,id'],
            'hsn_code' => ['nullable', 'string', 'max:20'],
            'mrp' => ['sometimes', 'numeric', 'min:0'],
            'purchase_price' => ['nullable', 'numeric', 'min:0'],
            'tax_rate_id' => ['nullable', 'integer', 'exists:tax_rates,id'],
            'image' => ['nullable', 'image', 'mimes:jpeg,png,jpg,webp', 'max:2048'],
        ]);

        $variant = $this->service->updateGiftProduct(
            $variant,
            $validated,
            $request->file('image')
        );

        return response()->json([
            'status' => true,
            'message' => 'Gift product updated.',
            'data' => ['gift_product' => $this->formatGiftProduct($variant)],
        ]);
    }

    public function toggleGiftProduct(ProductVariant $variant): JsonResponse
    {
        $variant = $this->service->toggleGiftProduct($variant);

        return response()->json([
            'status' => true,
            'message' => 'Gift product status updated.',
            'data' => ['gift_product' => $this->formatGiftProduct($variant)],
        ]);
    }

    // ── Usage / analytics ───────────────────────────────────────────

    public function usage(Request $request): JsonResponse
    {
        $request->validate([
            'campaign_id' => 'nullable|integer|exists:gift_campaigns,id',
            'search' => 'nullable|string|max:255',
            'per_page' => 'nullable|integer|min:10|max:100',
        ]);

        $usages = $this->service->usageList(
            $request->only(['campaign_id', 'search', 'per_page'])
        );

        return response()->json([
            'status' => true,
            'message' => 'Gift usage retrieved.',
            'data' => [
                'data' => collect($usages->items())->map(fn ($usage) => [
                    'id' => $usage->id,
                    'campaign' => $usage->campaign ? [
                        'id' => $usage->campaign->id,
                        'name' => $usage->campaign->name,
                    ] : null,
                    'customer' => $usage->customer ? [
                        'id' => $usage->customer->id,
                        'name' => $usage->customer->name,
                        'phone' => $usage->customer->phone,
                    ] : null,
                    'order' => $usage->order ? [
                        'id' => $usage->order->id,
                        'order_number' => $usage->order->order_number,
                        'total' => (float) $usage->order->total,
                        'status' => $usage->order->status,
                    ] : null,
                    'items' => $usage->items,
                    'used_at' => $usage->used_at?->toDateTimeString(),
                    // Set when the order expired / failed payment after the
                    // gifts were recorded — the usage no longer counts
                    // towards any cap.
                    'released_at' => $usage->released_at?->toDateTimeString(),
                ]),
                'meta' => [
                    'current_page' => $usages->currentPage(),
                    'last_page' => $usages->lastPage(),
                    'per_page' => $usages->perPage(),
                    'total' => $usages->total(),
                ],
            ],
        ]);
    }

    // ── Helpers ─────────────────────────────────────────────────────

    private function campaignRules(bool $required = true): array
    {
        // 'required' on create; 'sometimes' on update (partial payloads).
        $req = $required ? 'required' : 'sometimes';

        return [
            'name' => [$req, 'string', 'max:100'],
            'tier_mode' => ['nullable', 'in:exact,cumulative'],
            'threshold_basis' => ['nullable', 'in:after_coupon,before_coupon'],
            'usage_limit_total' => ['nullable', 'integer', 'min:1'],
            'usage_limit_per_customer' => ['nullable', 'integer', 'min:1'],
            'valid_from' => [$req, 'date'],
            'valid_until' => ['nullable', 'date', 'after_or_equal:valid_from'],
            'is_active' => ['boolean'],
            'tiers' => [$req, 'array', 'min:1'],
            'tiers.*.threshold_amount' => ['required', 'numeric', 'min:0.01'],
            'tiers.*.selection_mode' => ['nullable', 'in:all,choose_one'],
            'tiers.*.items' => ['required', 'array', 'min:1'],
            'tiers.*.items.*.product_variant_id' => ['required', 'integer', 'exists:product_variants,id'],
            'tiers.*.items.*.quantity' => ['nullable', 'integer', 'min:1', 'max:10'],
        ];
    }

    private function formatGiftProduct(ProductVariant $variant): array
    {
        return [
            'id' => $variant->id,
            'product_id' => $variant->product_id,
            'name' => $variant->product?->name,
            'description' => $variant->product?->description,
            'category' => $variant->product?->category?->name,
            'sku' => $variant->sku,
            'unit_id' => $variant->unit_id,
            'unit_abbr' => $variant->unit?->abbreviation,
            'hsn_code' => $variant->hsn_code,
            'mrp' => (float) $variant->mrp,
            'purchase_price' => $variant->purchase_price !== null ? (float) $variant->purchase_price : null,
            'selling_price' => 0.0,
            'tax_label' => $variant->taxRate?->label,
            'image' => $variant->image,
            'image_url' => $variant->image
                ? \Storage::disk('public')->url('tenants/'.tenant('id').'/variants/'.$variant->image)
                : null,
            'total_stock' => (int) ($variant->total_stock ?? 0),
            'total_reserved' => (int) ($variant->total_reserved ?? 0),
            'available_stock' => max(0, (int) ($variant->total_stock ?? 0) - (int) ($variant->total_reserved ?? 0)),
            'is_active' => $variant->is_active,
            'is_gift' => true,
            'created_at' => $variant->created_at?->toDateTimeString(),
        ];
    }
}
