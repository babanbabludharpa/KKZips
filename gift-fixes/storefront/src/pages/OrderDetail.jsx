import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowLeft, MapPin, Phone, CreditCard, Package, Truck, CheckCircle2, Clock,
  Tag, Receipt, Download, Image as ImageIcon,
} from "lucide-react";
import customerApi from "../api/customerApi";
import { useCustomerAuth } from "../store/useCustomerAuth";
import { useTenant } from "../contexts/TenantProvider";

// ── Image URL helpers (variant image is a filename, needs storage base) ──
function fixImageUrl(url) {
  if (!url) return null;
  if (url.startsWith("http") || url.startsWith("data:") || url.startsWith("blob:")) return url;
  const backendUrl =
    import.meta.env.VITE_API_URL ||
    import.meta.env.VITE_BACKEND_URL ||
    "http://localhost:8000";
  return backendUrl + (url.startsWith("/") ? url : "/" + url);
}
const storageBase = (() => {
  const explicit = import.meta.env.VITE_STORAGE_URL;
  if (explicit) return explicit.endsWith("/") ? explicit : explicit + "/";
  const base = import.meta.env.VITE_API_URL || import.meta.env.VITE_BACKEND_URL || "http://localhost:8000";
  try { return new URL(base).origin + "/storage/"; } catch { return base + "/storage/"; }
})();

const STATUS_CONFIG = {
  pending_payment:   { bg: "#FEF3C7", fg: "#92400E", label: "Payment Pending", icon: Clock },
  confirmed:         { bg: "#DBEAFE", fg: "#1E40AF", label: "Confirmed", icon: CheckCircle2 },
  preparing:         { bg: "#E0E7FF", fg: "#3730A3", label: "Preparing", icon: Package },
  out_for_delivery:  { bg: "#FFEDD5", fg: "#9A3412", label: "Out for Delivery", icon: Truck },
  delivered:         { bg: "#DCFCE7", fg: "#15803D", label: "Delivered", icon: CheckCircle2 },
  cancelled:         { bg: "#FEE2E2", fg: "#B91C1C", label: "Cancelled", icon: Package },
  payment_failed:    { bg: "#FEE2E2", fg: "#B91C1C", label: "Payment Failed", icon: Clock },
};

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const fmtDateTime = (d) =>
  d ? new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
const fmtMoney = (n) => `₹${Number(n ?? 0).toFixed(2)}`;

export default function OrderDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated } = useCustomerAuth();
  const { theme: tenantTheme } = useTenant();

  // ★ Dynamic theme — primary from tenant, neutrals stay constant
  const theme = {
    primary: tenantTheme?.primary_color || "#666666",
    dark: "#1E293B",
    mid: "#64748B",
    bg: "#F8FAFF",
    border: "#E2E8F0",
    success: "#22C55E",
    error: "#EF4444",
  };

  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [downloadingInvoice, setDownloadingInvoice] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate("/", { replace: true });
      return;
    }
    fetchOrder();
  }, [isAuthenticated, id]);

  const fetchOrder = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await customerApi.get(`/mobile/orders/${id}`);
      if (res.data?.status) {
        setOrder(res.data.data);
      }
    } catch (e) {
      setError(e?.response?.data?.message || e.message || "Failed to load order.");
    } finally {
      setLoading(false);
    }
  };

  // ★ Download invoice — backend returns PDF as binary blob
  const handleDownloadInvoice = async () => {
    if (downloadingInvoice || !order) return;
    setDownloadingInvoice(true);
    try {
      const response = await customerApi.get(`/mobile/orders/${order.id}/invoice`, {
        responseType: "blob",
      });

      // Defensive: if backend returned JSON error instead of PDF, surface it
      if (response.data?.type && response.data.type.includes("application/json")) {
        const text = await response.data.text();
        const errData = JSON.parse(text);
        throw new Error(errData?.message || "Invoice download failed");
      }

      const blob = new Blob([response.data], { type: "application/pdf" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `invoice-${order.order_number || order.id}.pdf`.replace(/\//g, "-");
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Invoice download failed:", e);
      alert(e?.message || "Failed to download invoice. Please try again.");
    } finally {
      setDownloadingInvoice(false);
    }
  };

  if (!isAuthenticated) {
    return <div style={{ padding: "3rem", textAlign: "center", color: theme.mid }}>Please log in to view this order.</div>;
  }

  if (loading) {
    return (
      <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", background: theme.bg }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ width: 40, height: 40, border: `4px solid ${theme.border}`, borderTopColor: theme.primary, borderRadius: "50%", margin: "0 auto 16px", animation: "spin 0.8s linear infinite" }} />
          <div style={{ color: theme.mid }}>Loading order…</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div style={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", background: theme.bg, padding: 24 }}>
        <div style={{ background: "#fff", borderRadius: 20, padding: 40, textAlign: "center", maxWidth: 480, border: `1px solid ${theme.border}` }}>
          <h3 style={{ color: theme.dark, marginBottom: 8 }}>Order not found</h3>
          <p style={{ color: theme.mid, marginBottom: 24 }}>{error || "Could not load this order."}</p>
          <button onClick={() => navigate("/orders")} style={{ padding: "12px 24px", background: theme.primary, color: "#fff", border: "none", borderRadius: 12, fontWeight: 600, cursor: "pointer" }}>
            Back to Orders
          </button>
        </div>
      </div>
    );
  }

  const status = STATUS_CONFIG[order.status] || { bg: "#F1F5F9", fg: "#64748B", label: order.status, icon: Package };
  const StatusIcon = status.icon;
  const items = Array.isArray(order.items) ? order.items : [];
  const addr = order.delivery_address || {};

  // Tax totals
  const totalCgst = items.reduce((acc, it) => acc + Number(it.cgst_amount || 0), 0);
  const totalSgst = items.reduce((acc, it) => acc + Number(it.sgst_amount || 0), 0);
  const totalIgst = items.reduce((acc, it) => acc + Number(it.igst_amount || 0), 0);

  // ★ Order number (prefer order_number, fallback to id)
  const orderNo = order.order_number || order.order_no || `#${order.id}`;

  // ★ Delivery photo (only when delivered + photo exists)
  const deliveryPhotoUrl = order.delivery_photo_path ? fixImageUrl(order.delivery_photo_path) : null;
  const showDeliveryProof = (order.status === "delivered" || order.delivered_at) && deliveryPhotoUrl;

  return (
    <div style={{ minHeight: "100vh", background: theme.bg, paddingBottom: 40 }}>
      {/* ── HERO HEADER ────────────────────────────────────────── */}
      <div style={{ background: "var(--color-primary, #666666)", padding: "48px 24px 80px", position: "relative", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px)", backgroundSize: "30px 30px", pointerEvents: "none" }} />
        <div style={{ position: "relative", zIndex: 1, maxWidth: 900, margin: "0 auto" }}>
          <button onClick={() => navigate("/orders")} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.15)", border: "1px solid rgba(255,255,255,0.2)", color: "#fff", padding: "8px 16px", borderRadius: 100, fontSize: "0.85rem", fontWeight: 600, cursor: "pointer", marginBottom: 20, backdropFilter: "blur(4px)" }}>
            <ArrowLeft size={14} /> Back to Orders
          </button>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
            <div>
              <motion.h1 initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} style={{ color: "#fff", fontSize: "clamp(1.5rem, 4vw, 2.2rem)", fontWeight: 900, margin: "0 0 4px", textShadow: "0 4px 12px rgba(0,0,0,0.2)", letterSpacing: "-0.02em" }}>
                Order #{orderNo}
              </motion.h1>
              <div style={{ color: "rgba(255,255,255,0.9)", fontSize: "0.9rem", display: "flex", gap: 12, flexWrap: "wrap" }}>
                <span>{fmtDateTime(order.created_at)}</span>
                {order.branch && (<><span>•</span><span>{order.branch.name}</span></>)}
              </div>
            </div>
            <div style={{ background: status.bg, color: status.fg, padding: "10px 20px", borderRadius: 100, fontWeight: 700, fontSize: "0.9rem", display: "flex", alignItems: "center", gap: 8, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              <StatusIcon size={16} />
              {status.label}
            </div>
          </div>
        </div>
      </div>

      {/* ── Content ────────────────────────────────────────────── */}
      <div style={{ maxWidth: 900, margin: "-48px auto 0", padding: "0 24px", position: "relative", zIndex: 10, display: "flex", flexDirection: "column", gap: 20 }}>

        {/* ── Items (with product image) ────────────────────── */}
<motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} style={{ background: "#fff", borderRadius: 20, padding: 24, border: `1px solid ${theme.border}`, boxShadow: "0 4px 24px rgba(0,0,0,0.04)" }}>
          {/* ★ Header row: Items count on left, Download Invoice button on right */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20, flexWrap: "wrap", gap: 12 }}>
            <h3 style={{ fontSize: "1.1rem", fontWeight: 800, color: theme.dark, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
              <Package size={18} color={theme.primary} /> Items ({items.length})
            </h3>
            <button
              onClick={handleDownloadInvoice}
              disabled={downloadingInvoice}
              style={{
                padding: "8px 14px",
                background: downloadingInvoice ? "#F1F5F9" : theme.primary,
                color: downloadingInvoice ? "#94A3B8" : "#fff",
                border: "none",
                borderRadius: 10,
                fontWeight: 700,
                fontSize: "0.82rem",
                cursor: downloadingInvoice ? "not-allowed" : "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                flexShrink: 0,
              }}
            >
              {downloadingInvoice ? (
                <>
                  <div style={{ width: 14, height: 14, border: `2px solid #cbd5e1`, borderTopColor: theme.primary, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                  Preparing…
                  <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                </>
              ) : (
                <>
                  <Download size={14} />
                  Download Invoice
                </>
              )}
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {items.map((item, i) => {
              // ★ FREE GIFTS — gift lines are real order_items priced at ₹0,
              // born server-side only (GiftService). Flag them so a free line
              // never looks like a pricing mistake.
              const isGift = item.is_gift === true || item.is_gift === 1 || item.is_gift === "1";
              // ★ Product image — variant.image is a filename, needs storage base
              const productImage = item.variant?.image
                ? fixImageUrl(storageBase + "variants/" + item.variant.image)
                : null;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: 16, background: "#F8FAFF", borderRadius: 12, border: `1px solid ${theme.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    {/* ★ Product image (NEW) */}
                    <div style={{ width: 56, height: 56, borderRadius: 10, overflow: "hidden", background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, position: "relative" }}>
                      {productImage ? (
                        <img
                          src={productImage}
                          alt={item.variant?.product?.name || "Product"}
                          style={{ width: "100%", height: "100%", objectFit: "cover" }}
                          onError={(e) => {
                            e.currentTarget.style.display = "none";
                            e.currentTarget.nextSibling.style.display = "flex";
                          }}
                        />
                      ) : null}
                      <div style={{ display: productImage ? "none" : "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center", color: "#94A3B8" }}>
                        <ImageIcon size={20} />
                      </div>
                    </div>
                    {/* Quantity badge */}
                    <div style={{ width: 36, height: 36, borderRadius: 8, background: theme.primary, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: "0.85rem", flexShrink: 0 }}>
                      {item.quantity}×
                    </div>
                    <div>
                      <div style={{ fontWeight: 700, color: theme.dark, fontSize: "0.95rem", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        {item.variant?.product?.name || `Variant #${item.product_variant_id}`}
                        {isGift && (
                          <span style={{ background: "#ECFDF5", color: "#047857", border: "1px solid #A7F3D0", borderRadius: 999, padding: "1px 8px", fontSize: "0.68rem", fontWeight: 800, letterSpacing: "0.02em" }}>
                            FREE GIFT
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: "0.82rem", color: theme.mid }}>
                        {isGift ? "Included free with this order" : `${fmtMoney(item.final_price)} each`}
                        {!isGift && Number(item.discount_percent) > 0 && <span style={{ color: "#16A34A", marginLeft: 6 }}>({item.discount_percent}% off)</span>}
                      </div>
                    </div>
                  </div>
                  <div style={{ fontWeight: 800, color: isGift ? "#047857" : theme.dark }}>
                    {isGift ? "FREE" : fmtMoney(item.line_total)}
                  </div>
                </div>
              );
            })}
          </div>
        </motion.div>

        {/* ── Delivery Address ──────────────────────────────── */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} style={{ background: "#fff", borderRadius: 20, padding: 24, border: `1px solid ${theme.border}`, boxShadow: "0 4px 24px rgba(0,0,0,0.04)" }}>
          <h3 style={{ fontSize: "1.1rem", fontWeight: 800, color: theme.dark, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
            <MapPin size={18} color={theme.primary} /> Delivery Address
          </h3>
          <div style={{ padding: 16, background: "#F8FAFF", borderRadius: 12, border: `1px solid ${theme.border}` }}>
            <div style={{ fontWeight: 700, color: theme.dark, marginBottom: 4 }}>{addr.name || "—"}</div>
            <div style={{ fontSize: "0.88rem", color: theme.mid, lineHeight: 1.5, marginBottom: 8 }}>
              {addr.line1 || addr.address || "—"}
              {addr.city && `, ${addr.city}`}
              {addr.pincode && ` - ${addr.pincode}`}
            </div>
            {addr.phone && (
              <div style={{ fontSize: "0.82rem", color: theme.mid, display: "flex", alignItems: "center", gap: 4 }}>
                <Phone size={12} /> {addr.phone}
              </div>
            )}
          </div>
          {order.customer_remark && (
            <div style={{ marginTop: 12, padding: 12, background: "#FEF3C7", borderRadius: 10, border: "1px solid #FDE68A", fontSize: "0.85rem", color: "#92400E" }}>
              <strong>Note:</strong> {order.customer_remark}
            </div>
          )}
        </motion.div>

        {/* ── Bill Summary ──────────────────────────────────── */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} style={{ background: "#fff", borderRadius: 20, padding: 24, border: `1px solid ${theme.border}`, boxShadow: "0 4px 24px rgba(0,0,0,0.04)" }}>
          <h3 style={{ fontSize: "1.1rem", fontWeight: 800, color: theme.dark, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
            <Receipt size={18} color={theme.primary} /> Bill Details
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: "0.92rem" }}>
            <Row label="Subtotal" value={fmtMoney(order.subtotal)} />
            <Row label="Delivery Charge" value={fmtMoney(order.delivery_charge)} valueColor={Number(order.delivery_charge) === 0 ? "#16A34A" : theme.dark} />
            {Number(order.coupon_discount) > 0 && (
              <Row label={`Coupon (${order.coupon_code})`} value={`−${fmtMoney(order.coupon_discount)}`} valueColor="#16A34A" icon={<Tag size={12} />} />
            )}
            {totalCgst > 0 && <Row label="CGST" value={fmtMoney(totalCgst)} muted />}
            {totalSgst > 0 && <Row label="SGST" value={fmtMoney(totalSgst)} muted />}
            {totalIgst > 0 && <Row label="IGST" value={fmtMoney(totalIgst)} muted />}
            <div style={{ borderTop: `2px dashed ${theme.border}`, marginTop: 8, paddingTop: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 800, color: theme.dark, fontSize: "1.1rem" }}>Total Paid</span>
              <span style={{ fontWeight: 900, color: theme.primary, fontSize: "1.4rem" }}>{fmtMoney(order.total)}</span>
            </div>
          </div>
        </motion.div>

        {/* ── Payment Info ──────────────────────────────────── */}
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} style={{ background: "#fff", borderRadius: 20, padding: 24, border: `1px solid ${theme.border}`, boxShadow: "0 4px 24px rgba(0,0,0,0.04)" }}>
          <h3 style={{ fontSize: "1.1rem", fontWeight: 800, color: theme.dark, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
            <CreditCard size={18} color={theme.primary} /> Payment Info
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
            <InfoBox label="Payment Mode" value={order.payment_mode === "cod" ? "Cash on Delivery" : "Online (Razorpay)"} />
            <InfoBox label="Payment Status" value={order.payment_status || "—"} valueColor={order.payment_status === "paid" ? "#16A34A" : order.payment_status === "failed" ? "#DC2626" : theme.dark} />
            {order.razorpay_payment_id && <InfoBox label="Payment ID" value={order.razorpay_payment_id} />}
            {order.delivered_at && <InfoBox label="Delivered At" value={fmtDateTime(order.delivered_at)} />}
          </div>
        </motion.div>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────
function Row({ label, value, muted, valueColor, icon }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ color: muted ? "#94A3B8" : "#64748B", display: "flex", alignItems: "center", gap: 4 }}>
        {icon}{label}
      </span>
      <span style={{ fontWeight: 600, color: valueColor || "#1E293B" }}>{value}</span>
    </div>
  );
}

function InfoBox({ label, value, valueColor }) {
  return (
    <div style={{ padding: 12, background: "#F8FAFF", borderRadius: 10, border: "1px solid #E2E8F0" }}>
      <div style={{ fontSize: "0.72rem", color: "#94A3B8", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4, fontWeight: 600 }}>{label}</div>
      <div style={{ fontWeight: 600, color: valueColor || "#1E293B", fontSize: "0.88rem", wordBreak: "break-all" }}>{value}</div>
    </div>
  );
}