<?php

namespace App\Http\Controllers\Api\V1\Mobile;

use App\Http\Controllers\Controller;
use App\Http\Resources\V1\CategoryResource;
use App\Models\Category;
use App\Models\Inventory;
use App\Models\Product;
use App\Services\V1\Orders\ZoneCheckService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class MobileProductController extends Controller
{
    private const CHANNELS = ['order', 'subscription'];

    public function __construct(private ZoneCheckService $zoneCheck) {}

    public function index(Request $request): JsonResponse
    {
        $branchId = $this->resolveBranch($request);
        $channel  = $this->resolveChannel($request);

        $query = Product::with([
            'category',
            'variants' => $this->variantsConstraint($channel),
            'variants.unit',
            'variants.taxRate',
            'variants.attributeValues.attribute',
            'variants.discountSchedules' => fn ($q) => $q->where('status', 'active'),
        ])->where('is_active', true)
            // ★ FREE GIFTS — a product is browsable only if it has at least
            // one real (non-gift) variant. Gift products are created with a
            // single is_gift variant, so this keeps them out of the catalogue
            // and out of the paginator totals without touching the gift engine.
            ->whereHas('variants', fn ($vq) => $vq->where('is_gift', false));

        if ($search = $request->get('search')) {
            $query->where(function ($q) use ($search) {
                $q->where('name', 'like', "%{$search}%")
                    ->orWhereHas('variants', fn ($vq) => $vq->where('sku', 'like', "%{$search}%"));
            });
        }

        if ($catId = $request->get('category_id')) {
            $query->where('category_id', $catId);
        }

        // When a channel is specified, exclude products that have no
        // variants available on that channel after the constraint above.
        if ($channel) {
            $flag = $channel === 'subscription'
                ? 'available_for_subscription'
                : 'available_for_order';

            $query->whereHas('variants', function ($vq) use ($flag) {
                $vq->where($flag, true)->where('is_active', true);
            });
        }

        $query->orderBy('name');

        if ($request->has('page')) {
            $perPage = (int) $request->get('per_page', 20);
            $perPage = max(1, min(100, $perPage));

            $paginator = $query->paginate($perPage, ['*'], 'page', (int) $request->get('page', 1));

            $items = collect($paginator->items());
            $inventoryMap = $this->preloadInventory($items, $branchId);

            return response()->json([
                'status' => true,
                'message' => 'Products retrieved.',
                'data' => $items
                    ->map(fn ($p) => $this->formatProduct($p, $branchId, $inventoryMap))
                    ->filter(fn ($p) => count($p['variants']) > 0)
                    ->values(),
                'meta' => [
                    'current_page' => $paginator->currentPage(),
                    'last_page' => $paginator->lastPage(),
                    'per_page' => $paginator->perPage(),
                    'total' => $paginator->total(),
                    'has_more' => $paginator->hasMorePages(),
                ],
            ]);
        }

        $products = $query->get();
        $inventoryMap = $this->preloadInventory($products, $branchId);

        return response()->json([
            'status' => true,
            'message' => 'Products retrieved.',
            'data' => $products
                ->map(fn ($p) => $this->formatProduct($p, $branchId, $inventoryMap))
                ->filter(fn ($p) => count($p['variants']) > 0)
                ->values(),
        ]);
    }

    public function show(Request $request, int $id): JsonResponse
    {
        $branchId = $this->resolveBranch($request);
        $channel  = $this->resolveChannel($request);

        $product = Product::with([
            'category',
            'variants' => $this->variantsConstraint($channel),
            'variants.unit',
            'variants.taxRate',
            'variants.attributeValues.attribute',
            'variants.discountSchedules' => fn ($q) => $q->where('status', 'active'),
        ])->where('is_active', true)
            // ★ FREE GIFTS — a gift product has no storefront page; 404 it
            // instead of rendering an empty, un-buyable product detail.
            ->whereHas('variants', fn ($vq) => $vq->where('is_gift', false))
            ->findOrFail($id);

        $inventoryMap = $this->preloadInventory(collect([$product]), $branchId);

        $data = $this->formatProduct($product, $branchId, $inventoryMap);

        // ★ NEW — embed builder-managed reviews (WebBuilder ⭐ Reviews tab,
        // stored in the layout's product_extras). Same source the web uses.
        $extras = $this->productExtras($product->id);
        $data['reviews'] = $extras['reviews'] ?? [];

        return response()->json([
            'status' => true,
            'data' => $data,
        ]);
    }

    public function categories(): JsonResponse
    {
        $categories = Category::where('is_active', true)
            // ★ FREE GIFTS — a category that exists only to hold gift
            // products (the auto-created "Gifts" bucket) is not a shoppable
            // category. Hide it so gifts stay a cart-only mechanic. Empty
            // categories with no products are kept exactly as before.
            ->where(function ($q) {
                $q->whereDoesntHave('products')
                    ->orWhereHas('products', fn ($p) => $p->whereHas(
                        'variants',
                        fn ($v) => $v->where('is_gift', false)
                    ));
            })
            ->orderBy('name')
            ->get();

        return response()->json([
            'status' => true,
            'data' => CategoryResource::collection($categories),
        ]);
    }

    // ── Helpers ──────────────────────────────────────────────────────

    /**
     * ★ Reviews / extras managed per product in the Web Builder.
     * Stored in the active web layout's layout_components under the
     * 'product_extras' entry: { [product_id]: { reviews: [...] } }.
     */
    private function productExtras(int $productId): array
    {
        // ⚠ REPLACE App\Models\WebLayout with the model your
        // appsettings/web/layouts controller actually queries.
        $layout = \App\Models\WebLayout::query()
            ->where('is_active', true)
            ->orderByDesc('id')
            ->first();

        if (! $layout) {
            return [];
        }

        $components = $layout->layout_components;
        if (is_string($components)) {
            $components = json_decode($components, true);
        }
        if (! is_array($components)) {
            return [];
        }

        foreach ($components as $component) {
            if (($component['page'] ?? null) === 'product_extras') {
                $data = $component['data'] ?? [];
                // keys arrive as "27" — PHP numeric-string keys match int lookups
                return is_array($data[$productId] ?? null) ? $data[$productId] : [];
            }
        }

        return [];
    }

    /**
     * Returns the closure passed to `with('variants', ...)`.
     * When $channel is null, no constraint is applied — full backward
     * compatibility for existing callers that don't opt in.
     *
     * ★ FREE GIFTS — gift variants are excluded everywhere, on every
     * channel, including search. They are granted only by GiftService.
     */
    private function variantsConstraint(?string $channel): \Closure
    {
        return function ($q) use ($channel) {
            $q->where('is_active', true)->where('is_gift', false);
            if ($channel === 'subscription') {
                $q->where('available_for_subscription', true);
            } elseif ($channel === 'order') {
                $q->where('available_for_order', true);
            }
        };
    }

    /**
     * Reads and validates the `channel` query param.
     * Returns null when missing or invalid — invalid values are treated
     * as "no filter" rather than silently filtering to nothing, which
     * would make the catalog go blank on a typo.
     */
    private function resolveChannel(Request $request): ?string
    {
        $channel = $request->get('channel');
        return in_array($channel, self::CHANNELS, true) ? $channel : null;
    }

    private function preloadInventory($products, ?int $branchId): array
    {
        if (! $branchId) {
            return [];
        }

        $variantIds = $products
            ->flatMap(fn ($p) => $p->variants->pluck('id'))
            ->unique()
            ->values();

        if ($variantIds->isEmpty()) {
            return [];
        }

        return Inventory::where('branch_id', $branchId)
            ->whereIn('product_variant_id', $variantIds)
            ->get()
            ->keyBy('product_variant_id')
            ->all();
    }

    private function resolveBranch(Request $request): ?int
    {
        $lat = $request->get('lat');
        $lng = $request->get('lng');

        if (! $lat || ! $lng) {
            return null;
        }

        $result = $this->zoneCheck->checkPoint((float) $lat, (float) $lng);

        return $result['branch_id'];
    }

    private function formatProduct(Product $product, ?int $branchId, array $inventoryMap = []): array
    {
        return [
            'id' => $product->id,
            'name' => $product->name,
            'description' => $product->description,
            'category_id' => $product->category_id,
            'category_name' => $product->category?->name,
            'variants' => $product->variants
                ->where('is_active', true)
                ->values()
                ->map(fn ($v) => $this->formatVariant($v, $branchId, $inventoryMap)),
        ];
    }

    private function formatVariant($variant, ?int $branchId, array $inventoryMap = []): array
    {
        $sellingPrice = (float) $variant->selling_price;
        $mrp = (float) $variant->mrp;
        $discountPct = 0;
        $finalPrice = $sellingPrice;

        if ($variant->is_discount_active && $variant->discountSchedules->isNotEmpty()) {
            $discountPct = (float) $variant->discountSchedules->first()->discount_percent;
            $finalPrice = round($sellingPrice * (1 - $discountPct / 100), 2);
        }

        $availableStock = null;
        $isOutOfStock = false;
        $isLowStock = false;

        if ($branchId) {
            $inventory = $inventoryMap[$variant->id] ?? null;

            $availableStock = $inventory
                ? max(0, $inventory->quantity - $inventory->quantity_reserved)
                : 0;

            $isOutOfStock = $availableStock === 0;
            $isLowStock = ! $isOutOfStock && $availableStock <= 5;
        }

        $attributes = $variant->attributeValues->map(fn ($av) => [
            'attribute_id' => $av->attribute_id,
            'attribute_name' => $av->attribute?->name,
            'value_id' => $av->id,
            'value' => $av->value,
        ])->values()->toArray();

        return [
            'id' => $variant->id,
            'sku' => $variant->sku,
            'mrp' => $mrp,
            'selling_price' => $sellingPrice,
            'final_price' => $finalPrice,
            'discount_percent' => $discountPct,
            'has_discount' => $discountPct > 0,
            'unit_name' => $variant->unit?->name,
            'unit_abbr' => $variant->unit?->abbreviation,
            'image_url' => $variant->image
                ? \Storage::disk('public')->url('tenants/'.tenant('id').'/variants/'.$variant->image)
                : null,
            'attributes' => $attributes,
            'available_stock' => $availableStock,
            'is_out_of_stock' => $isOutOfStock,
            'is_low_stock' => $isLowStock,
            'is_coupon_eligible' => $variant->is_coupon_eligible,

            // ── Channel flags (new) ──────────────────────────────────
            'available_for_order' => $variant->available_for_order,
            'available_for_subscription' => $variant->available_for_subscription,
        ];
    }
}