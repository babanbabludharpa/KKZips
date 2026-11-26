/**
 * ★ FREE GIFTS — animated cart progress bar (web storefront).
 *
 * Shows how close the cart is to the next free-gift threshold, with tier
 * markers on the track, a shimmering animated fill, chips for the next
 * tier's gifts (locked) and already-earned gifts (unlocked).
 *
 * Two data sources, one component:
 *
 *   1. Cart drawer (live): pass the useGiftProgress() hook output.
 *        <FreeGiftBar {...gifts} />            // campaign, tiers, progress, loading
 *
 *   2. Checkout (authoritative): pass the `gifts.progress` block from
 *      POST /mobile/orders/preview (no `tiers` there — markers are
 *      simply omitted and the headline uses the server numbers).
 *        <FreeGiftBar campaign={gifts.campaign} progress={gifts.progress}
 *                    ineligibleReason={gifts.ineligible_reason} />
 *
 * Display-only by design — the server decides what the order actually
 * earns (preview re-resolves, place() re-validates under lock).
 */

import React from 'react'
import { GiftIcon, CheckIcon, LockIcon } from './giftIcons'
import { formatINR, computeGiftProgress } from '../../hooks/useGiftProgress'
import './gifts.css'

/** Normalize hook progress (client) and preview progress (server) into
 *  one view model. Server shape: { basis, current_value,
 *  highest_earned_threshold, next_threshold, remaining }. */
function deriveBarState(progress, tiers) {
  const value = progress?.value ?? progress?.current_value ?? 0
  const highest =
    progress?.highest?.threshold_amount ?? progress?.highest_earned_threshold ?? null
  const next =
    progress?.next?.threshold_amount ?? progress?.next_threshold ?? null
  const remaining = progress?.remaining ?? (next ? Math.max(0, next - value) : null)

  const percent = next
    ? Math.min(100, (value / next) * 100)
    : highest
      ? 100
      : 0

  return { value, highest, next, remaining, percent }
}

export default function FreeGiftBar({
  campaign,
  tiers = [],
  progress = null,
  loading = false,
  ineligibleReason = null,
  className = '',
  hideChips = false,
}) {
  if (loading) {
    return (
      <div className={`kg-root kg-bar kg-bar--loading ${className}`.trim()}>
        <div className="kg-bar-head">
          <span className="kg-skel" style={{ width: 34, height: 34, borderRadius: 10 }} />
          <div style={{ flex: 1 }}>
            <div className="kg-skel" style={{ width: '55%', height: 12, marginBottom: 6 }} />
            <div className="kg-skel" style={{ width: '35%', height: 10 }} />
          </div>
        </div>
        <div className="kg-track">
          <span className="kg-skel" style={{ position: 'absolute', inset: 0, borderRadius: 999 }} />
        </div>
      </div>
    )
  }

  if (!campaign) return null

  // guard: a campaign without tiers (or a missing progress object with no
  // tier list to fall back on) has nothing to show — never claim "all unlocked"
  const effectiveProgress = progress ?? (tiers?.length ? computeGiftProgress(campaign, tiers, 0) : null)
  if (!effectiveProgress) return null

  const state = deriveBarState(effectiveProgress, tiers)
  const { value, highest, next, remaining, percent } = state

  // marker positions need the tier list (cart drawer mode)
  const sortedTiers = (tiers || [])
    .slice()
    .sort((a, b) => a.threshold_amount - b.threshold_amount)
  const maxThreshold = sortedTiers.length
    ? sortedTiers[sortedTiers.length - 1].threshold_amount
    : 1
  const markerList = sortedTiers
    .map((t) => ({
      threshold: t.threshold_amount,
      earned: highest !== null && t.threshold_amount <= highest,
      left: `${Math.min(100, (t.threshold_amount / maxThreshold) * 100)}%`,
    }))
    .filter((m, i, arr) => arr.findIndex((x) => x.left === m.left) === i)

  const tierState = !highest ? 'progress' : next ? 'earned' : 'complete'

  // ── headline copy ──────────────────────────────────────────────
  let title
  let sub
  if (ineligibleReason === 'campaign_limit_reached') {
    title = 'Free gifts fully claimed'
    sub = 'This campaign’s gifts are all given out — better luck next time.'
  } else if (ineligibleReason === 'customer_limit_reached') {
    title = 'Free gift already claimed'
    sub = 'You’ve already received your free gift in this campaign.'
  } else if (!highest && next) {
    title = `${formatINR(remaining)} away from a free gift`
    sub = `Spend ${formatINR(next)} to unlock:`
  } else if (highest && next) {
    title = 'Free gift unlocked'
    sub = `Add ${formatINR(remaining)} more to unlock the next gift`
  } else {
    title = 'All free gifts unlocked'
    sub = campaign.name ? `Enjoy your gifts from “${campaign.name}”` : 'Enjoy your gifts'
  }

  // chips: earned first (checked), then the next tier's gifts (locked)
  const earnedChips = (progress?.earnedLines ?? []).slice(0, 3)
  const nextGifts = next
    ? ((tiers || []).find((t) => t.threshold_amount === next)?.gifts ?? []).slice(0, 3)
    : []
  const extraEarned = Math.max(0, (progress?.earnedLines ?? []).length - 3)
  const extraNext = Math.max(
    0,
    ((tiers || []).find((t) => t.threshold_amount === next)?.gifts ?? []).length - 3,
  )

  return (
    <section
      className={[
        'kg-root',
        'kg-bar',
        ineligibleReason ? 'kg-bar--ineligible' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-state={tierState}
      aria-live="polite"
    >
      <header className="kg-bar-head">
        <span className="kg-bar-badge">
          <GiftIcon size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="kg-bar-title">{title}</div>
          <div className="kg-bar-sub">{sub}</div>
          {campaign.tier_mode === 'cumulative' && !ineligibleReason && (
            <div className="kg-bar-note">Gifts stack — every tier adds to the previous ones</div>
          )}
          {/* In the cart drawer the coupon is applied later, so an after-coupon
              campaign is an estimate here; checkout re-renders with the
              server's authoritative numbers. Say so instead of over-promising. */}
          {campaign.threshold_basis === 'after_coupon' && !ineligibleReason && (
            <div className="kg-bar-note">Based on your item total after coupons — confirmed at checkout</div>
          )}
        </div>
      </header>

      <div className="kg-track" role="progressbar"
        aria-valuemin={0}
        aria-valuemax={next ?? highest ?? 100}
        aria-valuenow={Math.round(value)}
        aria-label="Free gift progress">
        <div className="kg-fill" style={{ width: `${percent}%` }}>
          {percent > 4 && <span className="kg-shimmer" />}
        </div>

        {markerList.map((m) => (
          <span key={m.threshold} className="kg-marker" data-earned={m.earned} style={{ left: m.left }}>
            <span className="kg-marker-dot">
              {m.earned && <CheckIcon size={8} />}
            </span>
            <span className="kg-marker-label">{formatINR(m.threshold)}</span>
          </span>
        ))}
      </div>

      {!hideChips && (earnedChips.length > 0 || nextGifts.length > 0) && !ineligibleReason && (
        <div className="kg-chips">
          {earnedChips.map((g) => (
            <span key={`e-${g.product_variant_id}`} className="kg-chip kg-chip--earned" title={g.name}>
              {g.image_url ? (
                <img src={g.image_url} alt="" loading="lazy" />
              ) : (
                <span className="kg-chip-ph"><GiftIcon size={12} /></span>
              )}
              <span className="kg-chip-name">{g.name}</span>
              {g.quantity > 1 && <span className="kg-chip-qty">×{g.quantity}</span>}
              <span className="kg-chip-check"><CheckIcon size={12} /></span>
            </span>
          ))}
          {extraEarned > 0 && (
            <span className="kg-chip kg-chip--earned">+{extraEarned} more</span>
          )}

          {nextGifts.map((g) => (
            <span key={`n-${g.product_variant_id}`} className="kg-chip kg-chip--locked" title={g.name}>
              {g.image_url ? (
                <img src={g.image_url} alt="" loading="lazy" />
              ) : (
                <span className="kg-chip-ph"><GiftIcon size={12} /></span>
              )}
              <span className="kg-chip-name">{g.name}</span>
              {g.quantity > 1 && <span className="kg-chip-qty">×{g.quantity}</span>}
              <span className="kg-chip-lock"><LockIcon size={11} /></span>
            </span>
          ))}
          {extraNext > 0 && (
            <span className="kg-chip kg-chip--locked">+{extraNext} more</span>
          )}
        </div>
      )}
    </section>
  )
}
