import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  MapPin, CreditCard, CheckCircle2, ChevronLeft, ChevronDown, ShieldCheck, Tag, X, Loader, Truck, Download, AlertCircle, Wallet as WalletIcon, Plus,
} from "lucide-react";
import { useCart } from "./CartContext";
import customerApi, { unwrap } from "../api/customerApi";
import { useCustomerAuth } from "../store/useCustomerAuth";
import { useTenant } from "../contexts/TenantProvider";
// ★ FREE GIFTS — authoritative gift display at the point of payment.
// Everything here comes from POST /mobile/orders/preview (server-resolved
// for the serving branch); nothing is calculated or sent from the client.
import FreeGiftBar from "../components/gifts/FreeGiftBar";
import CartGiftLines from "../components/gifts/CartGiftLines";


const NEUTRALS = {
  dark: "#1E293B",
  mid: "#64748B",
  bg: "#F8FAFF",
  border: "#E2E8F0",
  success: "#22C55E",
  error: "#EF4444",
};

const inputStyle = {
  width: "100%", padding: "14px 16px", borderRadius: 12,
  border: `1.5px solid ${NEUTRALS.border}`, outline: "none",
  fontSize: "0.95rem", fontFamily: "inherit", background: "#fff", transition: "0.2s",
  boxSizing: "border-box",
};

export default function Checkout() {
  const { cartItems, cartTotal, setCartItems } = useCart();
  const { customer, isAuthenticated } = useCustomerAuth();
  const navigate = useNavigate();
  const { theme: tenantTheme } = useTenant();

  const theme = {
    ...NEUTRALS,
    primary: tenantTheme?.primary_color || "#666666",
  };

  const [addresses, setAddresses] = useState([]);
  const [selectedAddressId, setSelectedAddressId] = useState(null);
  const [showAddressDropdown, setShowAddressDropdown] = useState(false);
  const [paymentMode, setPaymentMode] = useState("cod");
  const [customerRemark, setCustomerRemark] = useState("");
  const [loading, setLoading] = useState(true);
  const [placing, setPlacing] = useState(false);
  const [isPlaced, setIsPlaced] = useState(false);
  const [placedOrderId, setPlacedOrderId] = useState(null);
  const [placedOrderNumber, setPlacedOrderNumber] = useState(null);
  const [orderedItems, setOrderedItems] = useState([]);
  const [downloadingInvoice, setDownloadingInvoice] = useState(false);

  // Coupon state
  const [couponCode, setCouponCode] = useState("");
  const [appliedCoupon, setAppliedCoupon] = useState(null);
  const [couponError, setCouponError] = useState(null);
  const [couponLoading, setCouponLoading] = useState(false);

  // All coupons state
  const [allCoupons, setAllCoupons] = useState([]);
  const [couponsLoading, setCouponsLoading] = useState(false);
  const [showAllCoupons, setShowAllCoupons] = useState(false);
  const [stockIssues, setStockIssues] = useState([]);

  // Preview state
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // ★ Wallet state
  const [walletBalance, setWalletBalance] = useState(null);
  const [walletLoading, setWalletLoading] = useState(true);

  // ── Download invoice ──────────────────────────────────────────────────
  const handleDownloadInvoice = async () => {
    if (downloadingInvoice || !placedOrderId) return;
    setDownloadingInvoice(true);
    try {
      const response = await customerApi.get(`/mobile/orders/${placedOrderId}/invoice`, {
        responseType: "blob",
      });

      if (response.data?.type && response.data.type.includes("application/json")) {
        const text = await response.data.text();
        const errData = JSON.parse(text);
        throw new Error(errData?.message || "Invoice download failed");
      }

      const blob = new Blob([response.data], { type: "application/pdf" });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `invoice-${placedOrderNumber || placedOrderId}.pdf`.replace(/\//g, "-");
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

  // ── Fetch saved addresses ──────────────────────────────────────────────
  useEffect(() => {
    const fetchAddresses = async () => {
      try {
        const data = await unwrap(await customerApi.get("/mobile/addresses"));
        const list = Array.isArray(data) ? data : [];
        setAddresses(list);
        const defaultAddr = list.find((a) => a.is_default) || list[0];
        if (defaultAddr) {
          setSelectedAddressId(defaultAddr.id);
        }
      } catch (e) {
        console.warn("Failed to load addresses:", e);
      } finally {
        setLoading(false);
      }
    };
    fetchAddresses();
  }, []);

  // ── Fetch all available coupons ────────────────────────────────────────
  useEffect(() => {
    const fetchAllCoupons = async () => {
      setCouponsLoading(true);
      try {
        const data = await unwrap(await customerApi.get("/mobile/coupons"));
        setAllCoupons(Array.isArray(data) ? data : []);
      } catch (e) {
        console.warn("Failed to load coupons:", e);
        setAllCoupons([]);
      } finally {
        setCouponsLoading(false);
      }
    };
    fetchAllCoupons();
  }, []);

  // ── ★ Fetch wallet balance ─────────────────────────────────────────────
  useEffect(() => {
    const fetchWallet = async () => {
      if (!isAuthenticated) {
        setWalletLoading(false);
        return;
      }
      try {
        const res = await customerApi.get("/mobile/wallet/balance");
        if (res.data?.status) {
          setWalletBalance(Number(res.data.data.balance || 0));
        } else {
          setWalletBalance(null);
        }
      } catch (e) {
        console.warn("Wallet balance fetch failed:", e);
        setWalletBalance(null);
      } finally {
        setWalletLoading(false);
      }
    };
    fetchWallet();
  }, [isAuthenticated]);

  const selectedAddress = addresses.find((a) => a.id === selectedAddressId);
  const otherAddresses = addresses.filter((a) => a.id !== selectedAddressId);

  // ── Preview order ───────────────────────────────────────────────────────
  const fetchPreview = useCallback(async () => {
    if (!selectedAddress || cartItems.length === 0) return;
    setPreviewLoading(true);
    try {
      const items = cartItems.map((item) => ({
        variant_id: item.variant_id || item.id,
        quantity: item.quantity,
      }));
      const payload = {
        lat: parseFloat(selectedAddress.latitude) || 0,
        lng: parseFloat(selectedAddress.longitude) || 0,
        items,
        coupon_code: appliedCoupon?.code || undefined,
      };
      const data = await unwrap(await customerApi.post("/mobile/orders/preview", payload));
      setPreview(data);
    } catch (e) {
      console.warn("Preview failed:", e);
    } finally {
      setPreviewLoading(false);
    }
  }, [selectedAddress, cartItems, appliedCoupon]);

  useEffect(() => {
    if (selectedAddress && cartItems.length > 0) {
      const timer = setTimeout(fetchPreview, 500);
      return () => clearTimeout(timer);
    }
  }, [selectedAddress, cartItems, appliedCoupon, fetchPreview]);

  // ── Re-validate stock at checkout time ─────────────────────────────────
  useEffect(() => {
    const revalidateStock = async () => {
      if (!selectedAddress || cartItems.length === 0) {
        setStockIssues([]);
        return;
      }
      try {
        const data = await unwrap(
          await customerApi.get("/mobile/products", {
            params: {
              lat: parseFloat(selectedAddress.latitude) || 0,
              lng: parseFloat(selectedAddress.longitude) || 0,
            },
          })
        );
        const list = Array.isArray(data) ? data : [];
        const stockMap = {};
        list.forEach((p) =>
          (p.variants || []).forEach((v) => {
            stockMap[v.id] = { stock: v.available_stock, oos: v.is_out_of_stock };
          })
        );
        const issues = cartItems
          .map((item) => {
            const key = item.variant_id || item.id;
            const s = stockMap[key];
            const label = (item.attributes || []).length
              ? `${item.name} (${item.attributes.map((a) => `${a.attribute_name}: ${a.value}`).join(" · ")})`
              : item.name;
            if (!s) return { key, label, reason: "no longer available" };
            if (s.oos === true) return { key, label, reason: "out of stock" };
            if (s.stock !== null && s.stock !== undefined && s.stock < item.quantity)
              return { key, label, reason: `only ${s.stock} left` };
            return null;
          })
          .filter(Boolean);
        setStockIssues(issues);
      } catch (e) {
        setStockIssues([]);
      }
    };
    revalidateStock();
  }, [selectedAddress, cartItems]);

  // ── Compute coupon eligibility ─────────────────────────────────────────
  const subtotal = preview?.subtotal || cartTotal;
  const computeEligibility = (coupon) => {
    if (coupon.already_used === true) {
      return { eligible: false, reason: "Already used" };
    }
    if (coupon.blocked_first_order === true) {
      return { eligible: false, reason: "First order only" };
    }
    const expiresAt = coupon.expires_at || coupon.valid_until || coupon.end_date || coupon.expiry_date;
    if (expiresAt && new Date(expiresAt) < new Date()) {
      return { eligible: false, reason: `Expired on ${new Date(expiresAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}` };
    }
    const minOrder = Number(
      coupon.min_order_amount ||
      coupon.min_order_value ||
      coupon.minimum_order_value ||
      coupon.min_subtotal || 0
    );
    if (minOrder > 0 && Number(subtotal) < minOrder) {
      const need = (minOrder - Number(subtotal)).toFixed(2);
      return { eligible: false, reason: `Add ₹${need} more (min ₹${minOrder})` };
    }
    return { eligible: true, reason: null };
  };

  const eligibleCount = allCoupons.filter(c => computeEligibility(c).eligible).length;

  // ── Apply coupon ───────────────────────────────────────────────────────
  const handleApplyCoupon = async (explicitCode) => {
    const codeToUse = (explicitCode || couponCode || "").trim();
    if (!codeToUse) return;

    setCouponLoading(true);
    setCouponError(null);
    try {
      const data = await unwrap(
        await customerApi.post("/mobile/coupons/validate", {
          code: codeToUse.toUpperCase(),
          subtotal: cartTotal,
        })
      );
      setAppliedCoupon(data);
      setCouponCode("");
      setShowAllCoupons(false);
    } catch (e) {
      const errs = e?.response?.data?.errors || e?.body?.errors;
      const firstErr = errs ? Object.values(errs)[0]?.[0] : null;
      setCouponError(firstErr || e?.response?.data?.message || e?.body?.message || "Invalid coupon.");
      setAppliedCoupon(null);
    } finally {
      setCouponLoading(false);
    }
  };

  const handleSelectCoupon = (coupon) => {
    if (couponLoading) return;
    setCouponCode(coupon.code);
    handleApplyCoupon(coupon.code);
  };

  const handleRemoveCoupon = () => {
    setAppliedCoupon(null);
    setCouponError(null);
  };

  // ── Load Razorpay script ───────────────────────────────────────────────
  const loadRazorpayScript = () =>
    new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve(true);
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });

  // ── Place order ────────────────────────────────────────────────────────
  const handlePlaceOrder = async (e) => {
    e.preventDefault();
    if (!selectedAddress) {
      alert("Please select a delivery address.");
      return;
    }
    setPlacing(true);
    try {
      const items = cartItems.map((item) => ({
        variant_id: item.variant_id || item.id,
        quantity: item.quantity,
      }));
      const payload = {
        lat: parseFloat(selectedAddress.latitude) || 0,
        lng: parseFloat(selectedAddress.longitude) || 0,
        items,
        payment_mode: paymentMode,
        delivery_address: {
          name: customer?.name || selectedAddress.label || "Customer",
          phone: customer?.phone || selectedAddress.phone || "",
          line1: [selectedAddress.flat_no, selectedAddress.address_line1, selectedAddress.address_line2].filter(Boolean).join(", "),
          city: selectedAddress.city || "",
          pincode: selectedAddress.pincode || "",
          lat: parseFloat(selectedAddress.latitude) || 0,
          lng: parseFloat(selectedAddress.longitude) || 0,
          state_id: null,
        },
        coupon_code: appliedCoupon?.code || undefined,
        customer_remark: customerRemark || undefined,
      };

      const data = await unwrap(await customerApi.post("/mobile/orders", payload));
      setPlacedOrderId(data.order_id);
      setPlacedOrderNumber(data.order_number || null);
      setOrderedItems([...cartItems]);

      // ★ Wallet: paid immediately, no Razorpay handshake.
      if (paymentMode === "wallet") {
        setIsPlaced(true);
        setCartItems([]);
        setPlacing(false);
        return;
      }

      if (paymentMode === "cod") {
        setIsPlaced(true);
        setCartItems([]);
        setPlacing(false);
        return;
      }

      if (paymentMode === "online" && data.razorpay) {
        const scriptLoaded = await loadRazorpayScript();
        if (!scriptLoaded) {
          alert("Razorpay failed to load. Please check your internet.");
          setPlacing(false);
          return;
        }
        const options = {
          key: data.razorpay.key_id || import.meta.env.VITE_RAZORPAY_KEY || "rzp_test_T15Jksjq3FVE4B",
          amount: data.razorpay.amount,
          currency: data.razorpay.currency || "INR",
          name: "Shop Hub",
          description: `Order #${data.order_id}`,
          order_id: data.razorpay.order_id,
          handler: async function (response) {
            try {
              await unwrap(
                await customerApi.post(`/mobile/orders/${data.order_id}/verify-payment`, {
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature: response.razorpay_signature,
                })
              );
              setIsPlaced(true);
              setCartItems([]);
            } catch (err) {
              alert("Payment verification failed. Please contact support.");
            }
            setPlacing(false);
          },
          prefill: {
            name: customer?.name || "",
            contact: customer?.phone || "",
            email: customer?.email || "",
          },
          theme: { color: theme.primary },
          modal: {
            ondismiss: function () {
              setPlacing(false);
              alert("Payment cancelled. Your order is saved as pending.");
            },
          },
        };
        const rzp = new window.Razorpay(options);
        rzp.on("payment.failed", function (response) {
          alert("Payment Failed: " + response.error.description);
          setPlacing(false);
        });
        rzp.open();
      }
    } catch (e) {
      const errs = e?.response?.data?.errors || e?.body?.errors;
      const firstErr = errs ? Object.values(errs)[0]?.[0] : null;
      alert(firstErr || e?.response?.data?.message || e?.body?.message || "Failed to place order.");
      setPlacing(false);
    }
  };

  // ── Empty cart ─────────────────────────────────────────────────────────
  if (cartItems.length === 0 && !isPlaced) {
    return (
      <div style={{ minHeight: "100vh", background: theme.bg, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <h2 style={{ color: theme.dark, marginBottom: 16 }}>Your Cart is Empty</h2>
        <button onClick={() => navigate("/products")} style={{ padding: "12px 24px", background: theme.primary, color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: "bold" }}>
          Browse Products
        </button>
      </div>
    );
  }

  // ── Order placed success ───────────────────────────────────────────────
  if (isPlaced) {
    return (
      <div style={{ minHeight: "100vh", background: theme.bg, padding: "40px 24px", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          style={{ background: "#fff", padding: "40px 32px", borderRadius: 24, boxShadow: "0 20px 40px rgba(0,0,0,0.05)", maxWidth: 560, width: "100%" }}
        >
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <CheckCircle2 size={72} color={theme.success} style={{ margin: "0 auto 16px" }} />
            <h2 style={{ fontSize: "1.8rem", color: theme.dark, fontWeight: 900, marginBottom: 8 }}>
              Order Placed!
            </h2>
            <p style={{ color: theme.mid, fontSize: "0.95rem", margin: 0 }}>
              {paymentMode === "cod"
                ? "Your order has been confirmed."
                : paymentMode === "wallet"
                ? "Payment successful from your wallet. Your order is confirmed."
                : "Payment successful. Your order is confirmed."}
            </p>
            {paymentMode === "wallet" && (
              <p style={{ color: theme.mid, fontSize: "0.82rem", marginTop: 4 }}>
                Paid via Wallet
              </p>
            )}
            {placedOrderId && (
              <p style={{ color: theme.mid, fontSize: "0.85rem", marginTop: 8 }}>
                {placedOrderNumber ? <>Order No: <strong style={{ color: theme.dark }}>#{placedOrderNumber}</strong></> : <>Order ID: <strong style={{ color: theme.dark }}>#{placedOrderId}</strong></>}
              </p>
            )}
          </div>

          <div style={{ background: "#F8FAFF", borderRadius: 16, padding: 20, marginBottom: 24, border: `1px solid ${theme.border}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: "1rem", color: theme.dark, fontWeight: 800 }}>
                Items Ordered ({orderedItems.length})
              </h3>
              <button
                onClick={handleDownloadInvoice}
                disabled={downloadingInvoice}
                style={{
                  padding: "8px 16px",
                  background: downloadingInvoice ? "#F1F5F9" : theme.primary,
                  color: downloadingInvoice ? "#94A3B8" : "#fff",
                  border: "none",
                  borderRadius: 8,
                  fontWeight: 700,
                  fontSize: "0.85rem",
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
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {orderedItems.map((item) => (
                <div key={item.variant_id ?? item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.88rem", padding: "8px 0", borderBottom: `1px dashed ${theme.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                    <div style={{ width: 36, height: 36, borderRadius: 7, overflow: "hidden", background: "#F1F5F9", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                      {item.image_url ? (
                        <img src={item.image_url} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                      ) : (
                        <span style={{ fontSize: 14 }}>📦</span>
                      )}
                    </div>
                    <span style={{ background: "#F1F5F9", padding: "3px 8px", borderRadius: 5, fontSize: "0.75rem", fontWeight: 700, color: theme.dark, flexShrink: 0 }}>{item.quantity}×</span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: theme.mid, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</div>
                      {(item.attributes || []).length > 0 && (
                        <div style={{ fontSize: "0.72rem", color: theme.mid, opacity: 0.85, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {(item.attributes || []).map((a) => `${a.attribute_name}: ${a.value}`).join(" · ")}
                        </div>
                      )}
                    </div>
                  </div>
                  <span style={{ fontWeight: 700, color: theme.dark, flexShrink: 0, marginLeft: 12 }}>₹{item.price * item.quantity}</span>
                </div>
              ))}
              {orderedItems.length === 0 && (
                <div style={{ textAlign: "center", color: theme.mid, fontSize: "0.85rem", padding: 16 }}>No items in this order.</div>
              )}
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <button onClick={() => navigate(`/orders/${placedOrderId}`)} style={{ padding: "14px 28px", background: theme.primary, color: "#fff", border: "none", borderRadius: 12, fontWeight: 700, cursor: "pointer" }}>
              View Order
            </button>
            <button onClick={() => navigate("/")} style={{ padding: "14px 28px", background: "#EFF6FF", color: theme.dark, border: "none", borderRadius: 12, fontWeight: 700, cursor: "pointer" }}>
              Go Home
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  // ── Loading ────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: theme.bg, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ width: 40, height: 40, border: `4px solid ${theme.border}`, borderTopColor: theme.primary, borderRadius: "50%", margin: "0 auto 16px", animation: "spin 0.8s linear infinite" }} />
          <div style={{ color: theme.mid }}>Loading checkout…</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      </div>
    );
  }

  // ── Calculate display totals ───────────────────────────────────────────
  const deliveryCharge = preview?.delivery_charge ?? 0;
  const couponDiscount = appliedCoupon?.discount || preview?.coupon_discount || 0;
  const total = preview?.total || Math.max(0, subtotal + deliveryCharge - couponDiscount);
  const deliveryInfo = preview?.delivery_info;

  // ★ Wallet eligibility
  const walletCoversTotal = walletBalance !== null && walletBalance >= total;
  const walletShortfall = walletBalance !== null ? Math.max(0, total - walletBalance) : 0;

  return (
    <div style={{ background: theme.bg, minHeight: "100vh", padding: "40px 24px" }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ marginBottom: 32 }}>
          <button onClick={() => navigate(-1)} style={{ background: "none", border: "none", display: "flex", alignItems: "center", gap: 8, color: theme.mid, cursor: "pointer", marginBottom: 24, fontWeight: 600 }}>
            <ChevronLeft size={20} /> Back
          </button>
          <h1 style={{ fontSize: "clamp(1.8rem, 3vw, 2.4rem)", fontWeight: 900, color: theme.dark, margin: 0 }}>
            Secure Checkout
          </h1>
        </div>

        <div className="checkout-grid">
          {/* ── LEFT: Address + Payment ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
            {/* Address selection — default visible, others in dropdown */}
            <div className="checkout-card">
              <h2 className="card-title">
                <MapPin size={22} color={theme.primary} /> Delivery Address
              </h2>

              {addresses.length === 0 ? (
                <div style={{ textAlign: "center", padding: 24, background: "#FEF3C7", borderRadius: 12, border: "1px solid #FDE68A" }}>
                  <p style={{ color: "#92400E", marginBottom: 12 }}>No saved addresses found.</p>
                  <button
                    onClick={() => isAuthenticated ? navigate("/addresses") : navigate("/login")}
                    style={{ padding: "8px 20px", background: theme.primary, color: "#fff", border: "none", borderRadius: 8, fontWeight: 600, cursor: "pointer" }}
                  >
                    {isAuthenticated ? "+ Add Address" : "Login to Add Address"}
                  </button>
                  {!isAuthenticated && (
                    <p style={{ fontSize: "0.75rem", color: theme.mid, marginTop: 8, margin: "8px 0 0" }}>
                      You need to log in first to manage delivery addresses.
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  {selectedAddress && (
                    <div style={{
                      padding: 16,
                      border: `2px solid ${theme.primary}`,
                      borderRadius: 12,
                      background: "#FFF7ED",
                      marginBottom: 12,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 4 }}>
                        <div style={{ fontWeight: 700, color: theme.dark, fontSize: "0.95rem" }}>
                          {selectedAddress.label || "Address"}
                          {selectedAddress.is_default && (
                            <span style={{ background: "#FEF3C7", color: "#92400E", padding: "2px 8px", borderRadius: 6, fontSize: "0.7rem", fontWeight: 700, marginLeft: 8 }}>DEFAULT</span>
                          )}
                        </div>
                      </div>
                      <div style={{ fontSize: "0.88rem", color: theme.mid, lineHeight: 1.5, marginBottom: 6 }}>
                        {[selectedAddress.flat_no, selectedAddress.address_line1, selectedAddress.address_line2, selectedAddress.area, selectedAddress.city, selectedAddress.pincode].filter(Boolean).join(", ")}
                      </div>
                      {selectedAddress.phone && (
                        <div style={{ fontSize: "0.82rem", color: theme.mid, display: "flex", alignItems: "center", gap: 4 }}>
                          📞 {selectedAddress.phone}
                        </div>
                      )}
                    </div>
                  )}

                  {otherAddresses.length > 0 && (
                    <div style={{ position: "relative", marginBottom: 12 }}>
                      <button
                        onClick={() => setShowAddressDropdown(!showAddressDropdown)}
                        style={{
                          width: "100%",
                          padding: "10px 14px",
                          background: "#fff",
                          border: `1px solid ${theme.border}`,
                          borderRadius: 10,
                          color: theme.primary,
                          fontWeight: 600,
                          cursor: "pointer",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          fontSize: "0.88rem",
                        }}
                      >
                        <span>Change Address ({otherAddresses.length} other{otherAddresses.length !== 1 ? "s" : ""})</span>
                        <ChevronDown size={16} style={{ transform: showAddressDropdown ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
                      </button>
                      {showAddressDropdown && (
                        <>
                          <div onClick={() => setShowAddressDropdown(false)} style={{ position: "fixed", inset: 0, zIndex: 9 }} />
                          <div style={{
                            position: "absolute",
                            top: "calc(100% + 4px)",
                            left: 0,
                            right: 0,
                            background: "#fff",
                            border: `1px solid ${theme.border}`,
                            borderRadius: 10,
                            zIndex: 10,
                            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
                            overflow: "hidden",
                            maxHeight: 280,
                            overflowY: "auto",
                          }}>
                            {otherAddresses.map((addr) => (
                              <button
                                key={addr.id}
                                onClick={() => {
                                  setSelectedAddressId(addr.id);
                                  setShowAddressDropdown(false);
                                }}
                                style={{
                                  width: "100%",
                                  padding: "12px 14px",
                                  background: "none",
                                  border: "none",
                                  borderBottom: `1px solid ${theme.border}`,
                                  textAlign: "left",
                                  cursor: "pointer",
                                  display: "block",
                                }}
                              >
                                <div style={{ fontWeight: 700, color: theme.dark, fontSize: "0.88rem", marginBottom: 2 }}>
                                  {addr.label || "Address"}
                                  {addr.is_default && (
                                    <span style={{ background: "#FEF3C7", color: "#92400E", padding: "1px 6px", borderRadius: 4, fontSize: "0.65rem", fontWeight: 700, marginLeft: 6 }}>DEFAULT</span>
                                  )}
                                </div>
                                <div style={{ fontSize: "0.8rem", color: theme.mid, lineHeight: 1.4 }}>
                                  {[addr.flat_no, addr.address_line1, addr.address_line2, addr.area, addr.city, addr.pincode].filter(Boolean).join(", ")}
                                </div>
                                {addr.phone && (
                                  <div style={{ fontSize: "0.75rem", color: theme.mid, marginTop: 2 }}>📞 {addr.phone}</div>
                                )}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  <button
                    onClick={() => isAuthenticated ? navigate("/addresses") : navigate("/login")}
                    style={{ width: "100%", padding: "10px", background: "transparent", border: `1px dashed ${theme.primary}`, color: theme.primary, borderRadius: 10, fontWeight: 600, cursor: "pointer" }}
                  >
                    {isAuthenticated ? "+ Add New Address" : "Login to Add Address"}
                  </button>
                </div>
              )}
            </div>

            {/* Remark */}
            <div className="checkout-card">
              <h2 className="card-title">
                <Tag size={22} color={theme.primary} /> Delivery Notes (optional)
              </h2>
              <textarea
                placeholder="Any delivery instructions? e.g. 'Call before delivery', 'Leave at door'"
                value={customerRemark}
                onChange={(e) => setCustomerRemark(e.target.value)}
                style={{ ...inputStyle, minHeight: 80, resize: "vertical" }}
              />
            </div>

            {/* Payment */}
            <div className="checkout-card">
              <h2 className="card-title">
                <CreditCard size={22} color={theme.primary} /> Payment Method
              </h2>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {/* COD */}
                <label style={{ display: "flex", alignItems: "center", gap: 16, border: paymentMode === "cod" ? `2px solid ${theme.primary}` : `1px solid ${theme.border}`, borderRadius: 12, padding: 16, cursor: "pointer", background: paymentMode === "cod" ? "#FFF7ED" : "#fff" }}>
                  <input type="radio" checked={paymentMode === "cod"} onChange={() => setPaymentMode("cod")} style={{ width: 18, height: 18 }} />
                  <div style={{ flex: 1 }}>
                    <h4 style={{ margin: 0, fontSize: "1rem", color: theme.dark, fontWeight: 700 }}>Cash on Delivery</h4>
                    <p style={{ margin: "4px 0 0", fontSize: "0.82rem", color: theme.mid }}>Pay when your order arrives</p>
                  </div>
                  <Truck size={24} color={paymentMode === "cod" ? theme.primary : "#94A3B8"} />
                </label>

                {/* Online */}
                <label style={{ display: "flex", alignItems: "center", gap: 16, border: paymentMode === "online" ? `2px solid ${theme.primary}` : `1px solid ${theme.border}`, borderRadius: 12, padding: 16, cursor: "pointer", background: paymentMode === "online" ? "#FFF7ED" : "#fff" }}>
                  <input type="radio" checked={paymentMode === "online"} onChange={() => setPaymentMode("online")} style={{ width: 18, height: 18 }} />
                  <div style={{ flex: 1 }}>
                    <h4 style={{ margin: 0, fontSize: "1rem", color: theme.dark, fontWeight: 700 }}>Online Payment</h4>
                    <p style={{ margin: "4px 0 0", fontSize: "0.82rem", color: theme.mid }}>Pay via UPI / Card / Net Banking (Razorpay)</p>
                  </div>
                  <CreditCard size={24} color={paymentMode === "online" ? theme.primary : "#94A3B8"} />
                </label>

                {/* ★ Wallet */}
                <label
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                    border: paymentMode === "wallet" ? `2px solid ${theme.primary}` : `1px solid ${theme.border}`,
                    borderRadius: 12,
                    padding: 16,
                    cursor: walletCoversTotal ? "pointer" : "not-allowed",
                    background: paymentMode === "wallet" ? "#FFF7ED" : "#fff",
                    opacity: walletCoversTotal ? 1 : 0.65,
                    position: "relative",
                  }}
                >
                  <input
                    type="radio"
                    checked={paymentMode === "wallet"}
                    onChange={() => walletCoversTotal && setPaymentMode("wallet")}
                    disabled={!walletCoversTotal}
                    style={{ width: 18, height: 18 }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h4 style={{ margin: 0, fontSize: "1rem", color: theme.dark, fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
                      Wallet
                      {walletLoading && <Loader size={12} className="animate-spin" color={theme.mid} />}
                    </h4>
                    <p style={{ margin: "4px 0 0", fontSize: "0.82rem", color: theme.mid }}>
                      {walletLoading && "Loading balance…"}
                      {!walletLoading && walletBalance === null && "Balance unavailable"}
                      {!walletLoading && walletBalance !== null && (
                        walletCoversTotal
                          ? <>Balance: <strong style={{ color: theme.dark }}>₹{walletBalance.toFixed(2)}</strong> · Pay instantly</>
                          : <>Balance: ₹{walletBalance.toFixed(2)} · <span style={{ color: theme.error, fontWeight: 600 }}>Add ₹{walletShortfall.toFixed(2)} more to use</span></>
                      )}
                    </p>
                  </div>
                  <WalletIcon size={24} color={paymentMode === "wallet" ? theme.primary : "#94A3B8"} />
                  {!walletLoading && walletBalance !== null && !walletCoversTotal && (
                    <button
                      type="button"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); navigate("/wallet"); }}
                      style={{
                        position: "absolute",
                        top: 8,
                        right: 8,
                        padding: "4px 10px",
                        background: theme.primary,
                        color: "#fff",
                        border: "none",
                        borderRadius: 6,
                        fontSize: "0.72rem",
                        fontWeight: 700,
                        cursor: "pointer",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <Plus size={11} /> Top up
                    </button>
                  )}
                </label>
              </div>
            </div>
          </div>

          {/* ── RIGHT: Summary + Coupon ── */}
          <div>
            <div className="sticky-summary" style={{ background: "#fff", borderRadius: 24, padding: 24, border: `1px solid ${theme.border}`, boxShadow: "0 10px 40px rgba(0,0,0,0.06)" }}>
              <h3 style={{ margin: "0 0 20px", fontSize: "1.3rem", color: theme.dark, fontWeight: 900, paddingBottom: 16, borderBottom: `1px dashed ${theme.border}` }}>
                Order Summary
              </h3>

              {/* Items */}
              <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 20, maxHeight: 280, overflowY: "auto" }}>
                {cartItems.map((item) => (
                  <div key={item.variant_id ?? item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.9rem" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0 }}>
                      <div style={{ width: 40, height: 40, borderRadius: 8, overflow: "hidden", background: "#F1F5F9", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {item.image_url ? (
                          <img src={item.image_url} alt={item.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                        ) : (
                          <span style={{ fontSize: 16 }}>📦</span>
                        )}
                      </div>
                      <span style={{ background: "#F1F5F9", padding: "4px 8px", borderRadius: 6, fontSize: "0.78rem", fontWeight: 700, color: theme.dark, flexShrink: 0 }}>{item.quantity}×</span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: theme.dark, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</div>
                        {(item.attributes || []).length > 0 && (
                          <div style={{ fontSize: "0.72rem", color: theme.mid, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {(item.attributes || []).map((a) => `${a.attribute_name}: ${a.value}`).join(" · ")}
                          </div>
                        )}
                      </div>
                    </div>
                    <span style={{ fontWeight: 700, color: theme.dark, flexShrink: 0, marginLeft: 8 }}>₹{item.price * item.quantity}</span>
                  </div>
                ))}
              </div>

              {/* ★ FREE GIFTS — server-resolved for this branch. The bar shows
                  progress / cap banners; the lines below are exactly what will
                  be attached at place(). `available: false` means that gift is
                  out of stock here and will be dropped from the order. */}
              {preview?.gifts?.campaign && (
                <div style={{ marginBottom: 16 }}>
                  <FreeGiftBar
                    campaign={preview.gifts.campaign}
                    progress={preview.gifts.progress}
                    ineligibleReason={preview.gifts.ineligible_reason}
                    hideChips
                  />
                </div>
              )}
              {(preview?.gifts?.earned || []).length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <CartGiftLines gifts={preview.gifts} mode="preview" />
                </div>
              )}

              {/* ★ Coupon input + All Coupons list */}
              <div style={{ marginBottom: 20, padding: 16, background: "#F8FAFF", borderRadius: 12, border: `1px solid ${theme.border}` }}>
                {appliedCoupon ? (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontWeight: 700, color: theme.success, fontSize: "0.9rem", display: "flex", alignItems: "center", gap: 4 }}>
                        <Tag size={14} /> {appliedCoupon.code}
                      </div>
                      <div style={{ fontSize: "0.78rem", color: theme.mid }}>{appliedCoupon.description || "Coupon applied"}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontWeight: 700, color: theme.success }}>−₹{appliedCoupon.discount}</span>
                      <button onClick={handleRemoveCoupon} style={{ background: "none", border: "none", cursor: "pointer", color: theme.error, padding: 4 }}>
                        <X size={16} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Manual coupon entry */}
                    <div style={{ display: "flex", gap: 8 }}>
                      <input
                        type="text"
                        value={couponCode}
                        onChange={(e) => setCouponCode(e.target.value)}
                        placeholder="Enter coupon code"
                        style={{ flex: 1, padding: "10px 12px", borderRadius: 8, border: `1px solid ${theme.border}`, fontSize: "0.85rem", outline: "none", textTransform: "uppercase" }}
                      />
                      <button
                        onClick={() => handleApplyCoupon()}
                        disabled={couponLoading || !couponCode.trim()}
                        style={{ padding: "0 16px", background: theme.primary, color: "#fff", border: "none", borderRadius: 8, fontWeight: 600, cursor: couponLoading ? "not-allowed" : "pointer", fontSize: "0.85rem", whiteSpace: "nowrap" }}
                      >
                        {couponLoading ? "…" : "Apply"}
                      </button>
                    </div>
                    {couponError && <div style={{ marginTop: 8, fontSize: "0.78rem", color: theme.error }}>{couponError}</div>}

                    {/* Available Coupons toggle + list */}
                    <div style={{ marginTop: 12 }}>
                      <button
                        onClick={() => setShowAllCoupons(!showAllCoupons)}
                        style={{ width: "100%", padding: "8px 0", background: "transparent", border: "none", color: theme.primary, fontWeight: 700, cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "0.85rem" }}
                      >
                        <span>
                          {couponsLoading
                            ? "Loading coupons…"
                            : allCoupons.length === 0
                            ? "No coupons available"
                            : `Available Coupons (${eligibleCount} of ${allCoupons.length} eligible)`}
                        </span>
                        {allCoupons.length > 0 && (
                          <ChevronDown size={14} style={{ transform: showAllCoupons ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
                        )}
                      </button>

                      {showAllCoupons && !couponsLoading && allCoupons.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
                          {allCoupons.map((coupon) => {
                            const { eligible, reason } = computeEligibility(coupon);
                            const discountLabel =
                              coupon.type === "percent" || coupon.type === "percentage"
                                ? `${Number(coupon.value || 0)}% off`
                                : coupon.type === "flat"
                                ? `₹${Number(coupon.value || 0)} off`
                                : coupon.description || "Discount available";
                            const minOrder = Number(
                              coupon.min_order_amount ||
                              coupon.min_order_value ||
                              coupon.minimum_order_value || 0
                            );
                            return (
                              <div
                                key={coupon.code}
                                onClick={() => eligible && handleSelectCoupon(coupon)}
                                style={{
                                  padding: "10px 12px",
                                  background: eligible ? "#FFF7ED" : "#F8FAFC",
                                  border: `1px solid ${eligible ? theme.primary : theme.border}`,
                                  borderRadius: 8,
                                  opacity: eligible ? 1 : 0.55,
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  cursor: eligible ? "pointer" : "not-allowed",
                                  transition: "background 0.15s",
                                }}
                                onMouseEnter={(e) => { if (eligible) e.currentTarget.style.background = "#FFEDD5"; }}
                                onMouseLeave={(e) => { if (eligible) e.currentTarget.style.background = "#FFF7ED"; }}
                              >
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontWeight: 700, color: theme.dark, fontSize: "0.88rem", display: "flex", alignItems: "center", gap: 6 }}>
                                    <Tag size={12} color={eligible ? theme.primary : "#94A3B8"} />
                                    {coupon.code}
                                    {eligible && <span style={{ color: theme.success, fontSize: "0.78rem" }}>✓</span>}
                                  </div>
                                  <div style={{ fontSize: "0.75rem", color: theme.mid, marginTop: 2 }}>
                                    {discountLabel}
                                    {minOrder > 0 && ` · min ₹${minOrder}`}
                                  </div>
                                  {!eligible && reason && (
                                    <div style={{ fontSize: "0.72rem", color: theme.error, marginTop: 3 }}>⨯ {reason}</div>
                                  )}
                                </div>
                                {eligible && (
                                  <div style={{ fontSize: "0.78rem", fontWeight: 700, color: theme.primary, marginLeft: 12, flexShrink: 0 }}>
                                    Apply →
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {showAllCoupons && !couponsLoading && allCoupons.length === 0 && (
                        <div style={{ textAlign: "center", color: theme.mid, fontSize: "0.82rem", padding: 12 }}>
                          No coupons available right now.
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>

              {/* ★ stock re-validation banner */}
              {stockIssues.length > 0 && (
                <div style={{ marginBottom: 20, padding: 14, background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, color: "#B91C1C", fontWeight: 800, fontSize: "0.9rem", marginBottom: 8 }}>
                    <AlertCircle size={14} /> Stock changed — update your cart
                  </div>
                  {stockIssues.map((issue) => (
                    <div key={issue.key} style={{ fontSize: "0.8rem", color: "#991B1B", padding: "3px 0" }}>
                      • {issue.label} — {issue.reason}
                    </div>
                  ))}
                  <button
                    onClick={() => {
                      const badKeys = new Set(stockIssues.map((i) => i.key));
                      setCartItems(cartItems.filter((i) => !badKeys.has(i.variant_id || i.id)));
                    }}
                    style={{ marginTop: 10, width: "100%", padding: "10px 14px", background: "#DC2626", color: "#fff", border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: "0.85rem" }}
                  >
                    Remove unavailable items ({stockIssues.length})
                  </button>
                </div>
              )}

              {/* Bill breakdown */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "16px 0", borderTop: `1px dashed ${theme.border}`, borderBottom: `1px dashed ${theme.border}`, marginBottom: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", color: theme.mid, fontSize: "0.92rem" }}>
                  <span>Subtotal</span>
                  <span style={{ fontWeight: 600, color: theme.dark }}>₹{subtotal.toFixed(2)}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", color: theme.mid, fontSize: "0.92rem" }}>
                  <span>Delivery Charge</span>
                  {previewLoading ? (
                    <span style={{ color: theme.mid, fontSize: "0.82rem" }}>Calculating…</span>
                  ) : deliveryCharge === 0 ? (
                    <span style={{ fontWeight: 700, color: theme.success }}>FREE</span>
                  ) : (
                    <span style={{ fontWeight: 600, color: theme.dark }}>₹{deliveryCharge.toFixed(2)}</span>
                  )}
                </div>
                {deliveryInfo?.amount_for_free > 0 && (
                  <div style={{ fontSize: "0.78rem", color: theme.success }}>
                    Add ₹{deliveryInfo.amount_for_free} more for FREE delivery!
                  </div>
                )}
                {couponDiscount > 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", color: theme.success, fontSize: "0.92rem" }}>
                    <span>Coupon Discount</span>
                    <span style={{ fontWeight: 600 }}>−₹{couponDiscount.toFixed(2)}</span>
                  </div>
                )}
                {deliveryInfo?.blocked && (
                  <div style={{ fontSize: "0.82rem", color: theme.error, fontWeight: 600 }}>
                    ⚠ {deliveryInfo.reason}
                  </div>
                )}
              </div>

              {/* ★ Wallet "balance after order" preview */}
              {paymentMode === "wallet" && walletBalance !== null && (
                <div style={{ display: "flex", justifyContent: "space-between", color: theme.mid, fontSize: "0.82rem", padding: "0 0 12px", borderBottom: `1px dashed ${theme.border}`, marginBottom: 20 }}>
                  <span>Wallet balance after this order</span>
                  <span style={{ fontWeight: 700, color: (walletBalance - total) >= 0 ? theme.success : theme.error }}>
                    ₹{(walletBalance - total).toFixed(2)}
                  </span>
                </div>
              )}

              {/* Total */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
                <span style={{ fontSize: "1rem", color: theme.dark, fontWeight: 700 }}>Total Payable</span>
                <span style={{ fontSize: "1.6rem", fontWeight: 900, color: theme.primary }}>₹{total.toFixed(2)}</span>
              </div>

              {/* Place order */}
              <button
                onClick={handlePlaceOrder}
                disabled={
                  placing ||
                  !selectedAddress ||
                  deliveryInfo?.blocked ||
                  stockIssues.length > 0 ||
                  (paymentMode === "wallet" && !walletCoversTotal)
                }
                style={{
                  width: "100%",
                  padding: 16,
                  background: placing
                    ? "#FDBA74"
                    : ((deliveryInfo?.blocked || stockIssues.length > 0 || (paymentMode === "wallet" && !walletCoversTotal))
                      ? "#E2E8F0"
                      : theme.primary),
                  color: "#fff",
                  border: "none",
                  borderRadius: 12,
                  fontSize: "1.05rem",
                  fontWeight: 800,
                  cursor:
                    placing ||
                    !selectedAddress ||
                    deliveryInfo?.blocked ||
                    stockIssues.length > 0 ||
                    (paymentMode === "wallet" && !walletCoversTotal)
                      ? "not-allowed"
                      : "pointer",
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  gap: 8,
                }}
              >
                {placing ? (
                  <><Loader size={18} className="animate-spin" /> Placing Order…</>
                ) : paymentMode === "cod" ? (
                  "Place Order (COD)"
                ) : paymentMode === "wallet" ? (
                  `Pay ₹${total.toFixed(2)} from Wallet`
                ) : (
                  "Pay & Place Order"
                )}
              </button>

              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 16, color: theme.mid, fontSize: "0.82rem" }}>
                <ShieldCheck size={16} color={theme.success} /> 100% Safe & Secure Payments
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .checkout-grid { display: grid; grid-template-columns: 1.3fr 1fr; gap: 40px; align-items: start; }
        .checkout-card { background: #fff; border-radius: 20px; padding: 28px; border: 1px solid ${theme.border}; box-shadow: 0 4px 20px rgba(0,0,0,0.03); }
        .card-title { font-size: 1.3rem; font-weight: 900; color: ${theme.dark}; margin: 0 0 20px; display: flex; align-items: center; gap: 10px; }
        .sticky-summary { position: sticky; top: 100px; }
        @media (max-width: 992px) {
          .checkout-grid { grid-template-columns: 1fr; }
          .sticky-summary { position: relative; top: 0; }
        }
      `}</style>
    </div>
  );
}