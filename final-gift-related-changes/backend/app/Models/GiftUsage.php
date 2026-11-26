<?php

namespace App\Models;

use App\Models\Tenant\Customer;
use App\Models\Tenant\Order;
use Illuminate\Database\Eloquent\Model;

class GiftUsage extends Model
{
    public $timestamps = false;

    protected $fillable = [
        'gift_campaign_id',
        'customer_id',
        'order_id',
        'items',
        'used_at',
        'released_at',
    ];

    protected $casts = [
        'items' => 'array',
        'used_at' => 'datetime',
        'released_at' => 'datetime',
    ];

    public function campaign()
    {
        return $this->belongsTo(GiftCampaign::class, 'gift_campaign_id');
    }

    public function customer()
    {
        return $this->belongsTo(Customer::class);
    }

    public function order()
    {
        return $this->belongsTo(Order::class);
    }
}
