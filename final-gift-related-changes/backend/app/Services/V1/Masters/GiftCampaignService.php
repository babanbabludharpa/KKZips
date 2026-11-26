<?php

namespace App\Services\V1\Masters;

use App\Models\Category;
use App\Models\GiftCampaign;
use App\Models\GiftTierItem;
use App\Models\GiftUsage;
use App\Models\Product;
use App\Models\ProductVariant;
use Illuminate\Http\UploadedFile;
use Illuminate\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Validation\ValidationException;

/**
 * ★ FREE GIFTS — admin-side management.
 *
 * Campaigns: create/update replace tiers wholesale (builder semantics);
 * only ONE campaign may be active at a time (activating one deactivates
 * the rest — that active campaign is also the tenant's kill switch).
 *
 * Gift products: born through this service ONLY, with is_gift = 1,
 * selling_price = 0 and both channel flags off. The normal product/
 * variant endpoints can never set or flip the flag (their validation
 * allowlists don't include it), and they refuse to touch gift variants.
 */
class GiftCampaignService
{
    private const DEFAULT_PAGE_SIZE = 25;

    private const MIN_PAGE_SIZE = 10;

    private const MAX_PAGE_SIZE = 100;

    // ── Campaigns ───────────────────────────────────────────────────

    public function getAll(array $filters = [])
    {
        $perPage = min(
            max((int) ($filters['per_page'] ?? self::DEFAULT_PAGE_SIZE), self::MIN_PAGE_SIZE),
            self::MAX_PAGE_SIZE
        );

        return GiftCampaign::query()
            ->with(['tiers.items.variant.product', 'tiers.items.variant.unit'])
            ->when($filters['search'] ?? null, fn ($q, $s) => $q->where('name', 'like', "%{$s}%"))
            ->when(isset($filters['is_active']), fn ($q) => $q->where('is_active', filter_var($filters['is_active'], FILTER_VALIDATE_BOOLEAN)))
            ->orderByDesc('created_at')
            ->paginate($perPage);
    }

    public function findById(int $id): GiftCampaign
    {
        return GiftCampaign::with(['tiers.items.variant.product', 'tiers.items.variant.unit'])
            ->findOrFail($id);
    }

    public function create(array $data): GiftCampaign
    {
        return DB::transaction(function () use ($data) {
            $campaign = GiftCampaign::create([
                'name' => $data['name'],
                'tier_mode' => $data['tier_mode'] ?? 'exact',
                'threshold_basis' => $data['threshold_basis'] ?? 'after_coupon',
                'usage_limit_total' => $data['usage_limit_total'] ?? null,
                'usage_limit_per_customer' => $data['usage_limit_per_customer'] ?? null,
                'valid_from' => $data['valid_from'],
                'valid_until' => $data['valid_until'] ?? null,
                'is_active' => false, // created inactive; activate explicitly
                'created_by' => Auth::id(),
            ]);

            $this->syncTiers($campaign, $data['tiers'] ?? []);

            // Allow create-and-activate in one shot (single-active rule).
            if (! empty($data['is_active'])) {
                $this->activate($campaign);
            }

            return $campaign->fresh(['tiers.items.variant.product']);
        });
    }

    public function update(GiftCampaign $campaign, array $data): GiftCampaign
    {
        return DB::transaction(function () use ($campaign, $data) {
            $campaign->update([
                'name' => $data['name'] ?? $campaign->name,
                'tier_mode' => $data['tier_mode'] ?? $campaign->tier_mode,
                'threshold_basis' => $data['threshold_basis'] ?? $campaign->threshold_basis,
                'usage_limit_total' => array_key_exists('usage_limit_total', $data) ? $data['usage_limit_total'] : $campaign->usage_limit_total,
                'usage_limit_per_customer' => array_key_exists('usage_limit_per_customer', $data) ? $data['usage_limit_per_customer'] : $campaign->usage_limit_per_customer,
                'valid_from' => $data['valid_from'] ?? $campaign->valid_from,
                'valid_until' => array_key_exists('valid_until', $data) ? $data['valid_until'] : $campaign->valid_until,
            ]);

            if (array_key_exists('tiers', $data)) {
                $this->syncTiers($campaign, $data['tiers'] ?? []);
            }

            if (array_key_exists('is_active', $data)) {
                if ($data['is_active']) {
                    $this->activate($campaign);
                } else {
                    $campaign->update(['is_active' => false]);
                }
            }

            return $campaign->fresh(['tiers.items.variant.product']);
        });
    }

    public function toggle(GiftCampaign $campaign): GiftCampaign
    {
        return DB::transaction(function () use ($campaign) {
            if (! $campaign->is_active) {
                $this->activate($campaign);
            } else {
                $campaign->update(['is_active' => false]);
            }

            return $campaign->fresh(['tiers.items.variant.product']);
        });
    }

    public function delete(GiftCampaign $campaign): void
    {
        if ($campaign->usages()->exists()) {
            throw ValidationException::withMessages([
                'campaign' => 'Cannot delete a campaign that has already gifted orders. Deactivate it instead.',
            ]);
        }

        $campaign->delete(); // cascades tiers + tier items
    }

    /**
     * Activate under the single-active rule. A campaign must have at
     * least one tier before it can go live.
     */
    private function activate(GiftCampaign $campaign): void
    {
        if ($campaign->tiers()->count() === 0) {
            throw ValidationException::withMessages([
                'campaign' => 'Add at least one tier with gifts before activating this campaign.',
            ]);
        }

        $campaign->update(['is_active' => true]);

        GiftCampaign::where('is_active', true)
            ->where('id', '!=', $campaign->id)
            ->update(['is_active' => false]);
    }

    /**
     * Replace all tiers (builder semantics: the UI sends the full tier
     * list on every save). Validates thresholds and gift variants
     * before touching anything — a bad payload rolls the whole
     * transaction back.
     */
    private function syncTiers(GiftCampaign $campaign, array $tiers): void
    {
        if (empty($tiers)) {
            throw ValidationException::withMessages([
                'tiers' => 'At least one tier with a threshold and gifts is required.',
            ]);
        }

        // ── Validate everything first ──
        $thresholds = [];
        foreach ($tiers as $tier) {
            $amount = (float) ($tier['threshold_amount'] ?? 0);
            if ($amount <= 0) {
                throw ValidationException::withMessages(['tiers' => 'Threshold must be greater than zero.']);
            }
            if (in_array($amount, $thresholds, true)) {
                throw ValidationException::withMessages(['tiers' => "Duplicate threshold ₹{$amount} — each tier needs a unique amount."]);
            }
            $thresholds[] = $amount;

            if (empty($tier['items'])) {
                throw ValidationException::withMessages(['tiers' => "Tier ₹{$amount} must contain at least one gift."]);
            }

            foreach ($tier['items'] as $item) {
                $variant = ProductVariant::find($item['product_variant_id'] ?? 0);
                if (! $variant || ! $variant->is_gift) {
                    throw ValidationException::withMessages([
                        'tiers' => 'Only gift products (created in the Free Gifts section) can be added to a tier.',
                    ]);
                }
            }
        }

        // ── Then write ──
        $campaign->tiers()->delete(); // cascades tier items

        foreach ($tiers as $tier) {
            $created = $campaign->tiers()->create([
                'threshold_amount' => $tier['threshold_amount'],
                'selection_mode' => $tier['selection_mode'] ?? 'all',
            ]);

            foreach ($tier['items'] as $item) {
                GiftTierItem::create([
                    'gift_tier_id' => $created->id,
                    'product_variant_id' => $item['product_variant_id'],
                    'quantity' => max(1, (int) ($item['quantity'] ?? 1)),
                ]);
            }
        }
    }

    // ── Gift products ───────────────────────────────────────────────

    public function giftProducts(array $filters = []): LengthAwarePaginator
    {
        $perPage = min(
            max((int) ($filters['per_page'] ?? self::DEFAULT_PAGE_SIZE), self::MIN_PAGE_SIZE),
            self::MAX_PAGE_SIZE
        );

        return ProductVariant::query()
            ->with(['product.category', 'unit', 'taxRate'])
            ->withSum('inventory as total_stock', 'quantity')
            ->withSum('inventory as total_reserved', 'quantity_reserved')
            ->gift()
            ->when($filters['search'] ?? null, function ($q, $s) {
                $q->where(function ($w) use ($s) {
                    $w->where('sku', 'like', "%{$s}%")
                        ->orWhereHas('product', fn ($p) => $p->where('name', 'like', "%{$s}%"));
                });
            })
            ->when(isset($filters['is_active']), fn ($q) => $q->where('is_active', filter_var($filters['is_active'], FILTER_VALIDATE_BOOLEAN)))
            ->orderByDesc('created_at')
            ->paginate($perPage);
    }

    public function createGiftProduct(array $data, ?UploadedFile $image = null): ProductVariant
    {
        $this->guardDuplicateSku($data['sku']);

        return DB::transaction(function () use ($data, $image) {
            $category = $this->resolveGiftCategory($data['category_id'] ?? null);

            $product = Product::create([
                'name' => $data['name'],
                'category_id' => $category->id,
                'description' => $data['description'] ?? null,
                'is_active' => true,
            ]);

            // Gift variants are NOT purchasable: price 0, both channels off,
            // coupon-ineligible. They are granted only via GiftService.
            $variant = $product->variants()->create([
                'sku' => $data['sku'],
                'unit_id' => $data['unit_id'],
                'hsn_code' => $data['hsn_code'] ?? null,
                'mrp' => $data['mrp'],
                'purchase_price' => $data['purchase_price'] ?? null,
                'selling_price' => 0,
                'is_gift' => true,
                'is_coupon_eligible' => false,
                'available_for_order' => false,
                'available_for_subscription' => false,
                'tax_rate_id' => $data['tax_rate_id'] ?? null,
                'min_order_qty' => 1,
                'is_active' => true,
            ]);

            if ($image) {
                $this->storeImage($variant, $image);
            }

            return $variant->fresh(['product.category', 'unit', 'taxRate']);
        });
    }

    public function updateGiftProduct(ProductVariant $variant, array $data, ?UploadedFile $image = null): ProductVariant
    {
        if (! $variant->is_gift) {
            throw ValidationException::withMessages([
                'variant' => 'This is not a gift product.',
            ]);
        }

        if (isset($data['sku']) && $data['sku'] !== $variant->sku) {
            $this->guardDuplicateSku($data['sku'], $variant->id);
        }

        return DB::transaction(function () use ($variant, $data, $image) {
            // Same partial-update rule as the variant fields below: send null
            // to clear the description, omit it to leave it untouched.
            $productUpdates = [];

            if (isset($data['name'])) {
                $productUpdates['name'] = $data['name'];
            }

            if (array_key_exists('description', $data)) {
                $productUpdates['description'] = $data['description'];
            }

            if (! empty($productUpdates)) {
                $variant->product()->update($productUpdates);
            }

            // Partial update: a field that was NOT sent is left alone, but a
            // field sent as null is an explicit "clear it". array_filter()
            // used to drop those nulls, making hsn_code / purchase_price /
            // tax_rate_id impossible to clear once set.
            $updates = [];

            foreach (['sku', 'unit_id', 'mrp'] as $field) {
                if (isset($data[$field])) {
                    $updates[$field] = $data[$field];
                }
            }

            foreach (['hsn_code', 'purchase_price', 'tax_rate_id'] as $field) {
                if (array_key_exists($field, $data)) {
                    $updates[$field] = $data[$field];
                }
            }

            if (! empty($updates)) {
                $variant->update($updates);
            }

            if ($image) {
                $this->storeImage($variant, $image);
            }

            return $variant->fresh(['product.category', 'unit', 'taxRate']);
        });
    }

    public function toggleGiftProduct(ProductVariant $variant): ProductVariant
    {
        if (! $variant->is_gift) {
            throw ValidationException::withMessages([
                'variant' => 'This is not a gift product.',
            ]);
        }

        $variant->update(['is_active' => ! $variant->is_active]);

        return $variant->fresh(['product.category', 'unit', 'taxRate']);
    }

    private function resolveGiftCategory(?int $categoryId): Category
    {
        if ($categoryId) {
            return Category::findOrFail($categoryId);
        }

        return Category::firstOrCreate(
            ['name' => 'Gifts'],
            ['is_active' => true]
        );
    }

    private function guardDuplicateSku(string $sku, ?int $excludeId = null): void
    {
        $exists = ProductVariant::where('sku', $sku)
            ->when($excludeId, fn ($q) => $q->where('id', '!=', $excludeId))
            ->exists();

        if ($exists) {
            throw ValidationException::withMessages([
                'sku' => "SKU '{$sku}' is already in use.",
            ]);
        }
    }

    private function storeImage(ProductVariant $variant, UploadedFile $file): void
    {
        $tenantId = tenant('id');
        $path = "tenants/{$tenantId}/variants";

        if ($variant->image) {
            Storage::disk('public')->delete("{$path}/{$variant->image}");
        }

        $filename = 'variant_'.$variant->id.'_'.time().'.'.$file->getClientOriginalExtension();
        $file->storeAs($path, $filename, 'public');

        $variant->update(['image' => $filename]);
    }

    // ── Usage / analytics ───────────────────────────────────────────

    public function usageList(array $filters = []): LengthAwarePaginator
    {
        $perPage = min(
            max((int) ($filters['per_page'] ?? self::DEFAULT_PAGE_SIZE), self::MIN_PAGE_SIZE),
            self::MAX_PAGE_SIZE
        );

        return GiftUsage::query()
            ->with([
                'campaign:id,name',
                'customer:id,name,phone',
                'order:id,order_number,total,status',
            ])
            ->when($filters['campaign_id'] ?? null, fn ($q, $id) => $q->where('gift_campaign_id', $id))
            ->when($filters['search'] ?? null, function ($q, $s) {
                $q->where(function ($w) use ($s) {
                    $w->whereHas('customer', fn ($c) => $c->where('name', 'like', "%{$s}%")->orWhere('phone', 'like', "%{$s}%"))
                        ->orWhereHas('order', fn ($o) => $o->where('order_number', 'like', "%{$s}%"));
                });
            })
            ->orderByDesc('used_at')
            ->paginate($perPage);
    }
}
