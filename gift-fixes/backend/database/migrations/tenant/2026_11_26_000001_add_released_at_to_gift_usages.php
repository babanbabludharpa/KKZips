<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

// ─────────────────────────────────────────────────────────────────────────
// FREE GIFTS — release tracking.
//
// A gift_usages row is written the instant an order is placed (gifts are
// attached inside OrderService::place()). If that order never completes —
// pending_payment past the timeout, or Razorpay verification fails — the
// reserved gift stock is released, but until now the usage stayed counted,
// which burnt the campaign's usage_limit_total and the customer's
// usage_limit_per_customer for a gift nobody received.
//
// released_at is stamped instead of deleting the row so the admin Usage Log
// remains a complete audit trail, and so a release can never run twice.
// ─────────────────────────────────────────────────────────────────────────

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('gift_usages', function (Blueprint $table) {
            $table->timestamp('released_at')->nullable()->after('used_at');
            $table->index('order_id');
        });
    }

    public function down(): void
    {
        Schema::table('gift_usages', function (Blueprint $table) {
            $table->dropIndex(['order_id']);
            $table->dropColumn('released_at');
        });
    }
};
