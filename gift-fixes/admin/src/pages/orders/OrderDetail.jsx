import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  CCard, CCardBody, CSpinner, CAlert, CBadge, CButton,
  CTable, CTableHead, CTableRow, CTableHeaderCell, CTableBody, CTableDataCell,
  CFormSelect, CFormLabel, CFormTextarea,
} from '@coreui/react'
import api from '../../api/api'
import PermissionGate from '../../components/PermissionGate'
import InvoicePrintButton from '../../components/InvoicePrintButton'
import ErrorBoundary from '../../components/ErrorBoundary'
import { formatIsoDateTime } from '../../utils/formatters'

// Mirrors OrderStatusService::SEQUENCE server-side — display-only.
const SEQUENCE = ['confirmed', 'preparing', 'out_for_delivery', 'picked_up', 'delivered']

const STATUS_COLORS = {
  pending_payment:  'warning',
  confirmed:        'info',
  preparing:        'info',
  packaging:        'info',
  out_for_delivery: 'primary',
  picked_up:        'primary',
  delivered:        'success',
  payment_failed:   'danger',
  cancelled:        'secondary',
  expired:          'secondary',
}

const STATUS_LABELS = {
  pending_payment:  'Awaiting Payment',
  confirmed:        'Confirmed',
  preparing:        'Preparing',
  packaging:        'Packaging',
  out_for_delivery: 'Out for Delivery',
  picked_up:        'Picked Up',
  delivered:        'Delivered',
  payment_failed:   'Payment Failed',
  cancelled:        'Cancelled',
  expired:          'Expired',
}

const OrderDetail = () => {
  const { id } = useParams()
  const navigate = useNavigate()

  const [order, setOrder] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [updating, setUpdating] = useState(false)

  const [deliveryBoys, setDeliveryBoys] = useState([])
  const [selectedDeliveryBoy, setSelectedDeliveryBoy] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    fetchOrder()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const fetchOrder = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.get(`/orders/${id}`)
      setOrder(res.data?.data ?? null)
    } catch (e) {
      setError(e.response?.data?.message ?? 'Failed to load order.')
    } finally {
      setLoading(false)
    }
  }

  const fetchDeliveryBoys = async () => {
    try {
      const res = await api.get(`/orders/${id}/available-delivery-boys`)
      setDeliveryBoys(res.data?.data ?? [])
    } catch {
      setDeliveryBoys([])
    }
  }

  useEffect(() => {
    if (order && SEQUENCE.includes(order.status) && order.status !== 'delivered') {
      fetchDeliveryBoys()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.status])

  const nextStatus = (() => {
    if (!order) return null
    const idx = SEQUENCE.indexOf(order.status)
    if (idx === -1 || idx === SEQUENCE.length - 1) return null
    return SEQUENCE[idx + 1]
  })()

  const handleAdvance = async () => {
    if (!nextStatus) return
    setUpdating(true)
    setError(null)
    try {
      const res = await api.patch(`/orders/${id}/status`, {
        status: nextStatus,
        delivery_boy_id: selectedDeliveryBoy || undefined,
        notes: notes || undefined,
      })
      setOrder(res.data?.data ?? null)
      setNotes('')
    } catch (e) {
      setError(e.response?.data?.message ?? 'Failed to update status.')
    } finally {
      setUpdating(false)
    }
  }

  if (loading) {
    return (
      <div className="report-page">
        <CCard className="report-shell">
          <CCardBody className="p-0">
            <div className="report-shell__loading">
              <CSpinner />
              <div className="report-shell__loading-text">Loading order...</div>
            </div>
          </CCardBody>
        </CCard>
      </div>
    )
  }

  if (!order) {
    return (
      <div className="report-page">
        <CCard className="report-shell">
          <CCardBody>
            <CAlert color="danger" className="mb-0">
              {error ?? 'Order not found.'}
            </CAlert>
          </CCardBody>
        </CCard>
      </div>
    )
  }

  const address = order.delivery_address ?? {}
  const items = Array.isArray(order.items) ? order.items : []
  const history = Array.isArray(order.status_history) ? order.status_history : []

  return (
    <ErrorBoundary>
      <div className="report-page">
        <CCard className="report-shell">
          {/* ==================== HEADER ==================== */}
          <div className="report-shell__header">
            <div>
              <div className="report-shell__title" style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <span>{order.order_number ?? `Order #${order.id}`}</span>
                <CBadge
                  color={STATUS_COLORS[order.status] ?? 'secondary'}
                  shape="rounded-pill"
                >
                  {STATUS_LABELS[order.status] ?? order.status}
                </CBadge>
              </div>
              <div className="report-shell__price-summary">
                <span className="text-muted" style={{ fontSize: '0.85rem' }}>
                  {order.branch?.name ?? '—'}
                </span>
              </div>
            </div>

            <div className="d-flex gap-2 flex-wrap">
              <InvoicePrintButton order={order} />
              <CButton
                size="sm"
                className="filter-btn filter-btn--ghost"
                onClick={() => navigate(-1)}
              >
                Back
              </CButton>
            </div>
          </div>

          {error && (
            <div className="report-shell__error">
              <CAlert color="danger" dismissible onClose={() => setError(null)}>
                {error}
              </CAlert>
            </div>
          )}

          {/* ==================== BODY ==================== */}
          <CCardBody>
            <div className="row g-4">
              <div className="col-md-7">
                {/* Items card */}
                <CCard className="report-shell mb-4">
                  <div className="report-shell__header" style={{ padding: '0.65rem 1rem' }}>
                    <strong style={{ fontSize: '0.95rem' }}>Items</strong>
                  </div>
                  <CCardBody className="p-0">
                    <CTable hover responsive bordered className="admin-data-table admin-data-table--preview mb-0">
                      <CTableBody>
                        {items.length === 0 ? (
                          <CTableRow>
                            <CTableDataCell className="text-center text-muted py-4">
                              No items on this order.
                            </CTableDataCell>
                          </CTableRow>
                        ) : (
                          items.map((item) => (
                            <CTableRow key={item.id}>
                              <CTableDataCell className="text-start">
                                {item.variant?.product?.name ?? item.variant?.sku ?? 'Item'}{' '}
                                <span className="text-muted">× {item.quantity}</span>
                                {/* ★ FREE GIFTS — ₹0 lines are granted by the
                                    server, never added by the customer. Mark
                                    them so nobody reads it as a bad price. */}
                                {(item.is_gift === true || item.is_gift === 1 || item.is_gift === '1') && (
                                  <CBadge color="success" shape="rounded-pill" className="ms-2">FREE GIFT</CBadge>
                                )}
                              </CTableDataCell>
                              <CTableDataCell className="text-end">
                                {(item.is_gift === true || item.is_gift === 1 || item.is_gift === '1') ? (
                                  <CBadge color="success">FREE</CBadge>
                                ) : (
                                  <strong>₹{item.line_total}</strong>
                                )}
                              </CTableDataCell>
                            </CTableRow>
                          ))
                        )}
                      </CTableBody>
                    </CTable>
                    <div style={{ padding: '0.75rem 1rem' }}>
                      <div className="d-flex justify-content-between">
                        <span>Subtotal</span>
                        <span>₹{order.subtotal}</span>
                      </div>
                      <div className="d-flex justify-content-between">
                        <span>Delivery</span>
                        <span>₹{order.delivery_charge}</span>
                      </div>
                      {Number(order.coupon_discount) > 0 && (
                        <div className="d-flex justify-content-between text-success">
                          <span>Coupon{order.coupon_code ? ` (${order.coupon_code})` : ''}</span>
                          <span>-₹{order.coupon_discount}</span>
                        </div>
                      )}
                      <div
                        className="d-flex justify-content-between mt-2"
                        style={{
                          fontWeight: 700,
                          fontSize: '1.05rem',
                          borderTop: '1px solid var(--rep-border)',
                          paddingTop: '0.5rem',
                        }}
                      >
                        <span>Total</span>
                        <span>₹{order.total}</span>
                      </div>
                    </div>
                  </CCardBody>
                </CCard>

                {/* Address card */}
                <CCard className="report-shell">
                  <div className="report-shell__header" style={{ padding: '0.65rem 1rem' }}>
                    <strong style={{ fontSize: '0.95rem' }}>Delivery Address</strong>
                  </div>
                  <CCardBody>
                    {address.name && <div>{address.name}</div>}
                    {address.phone && <div>{address.phone}</div>}
                    {address.line1 && <div>{address.line1}</div>}
                    {(address.city || address.pincode) && (
                      <div>
                        {address.city ?? ''}
                        {address.pincode ? ` - ${address.pincode}` : ''}
                      </div>
                    )}
                  </CCardBody>
                </CCard>
              </div>

              <div className="col-md-5">
                <PermissionGate permission="order.manage">
                  {nextStatus && (
                    <CCard className="report-shell mb-4">
                      <div className="report-shell__header" style={{ padding: '0.65rem 1rem' }}>
                        <strong style={{ fontSize: '0.95rem' }}>Advance Status</strong>
                      </div>
                      <CCardBody>
                        <p className="text-muted small">
                          Move this order from{' '}
                          <strong>{STATUS_LABELS[order.status] ?? order.status}</strong> to{' '}
                          <strong>{STATUS_LABELS[nextStatus]}</strong>.
                        </p>

                        {deliveryBoys.length > 0 && (
                          <div className="mb-3">
                            <CFormLabel className="filter-label">
                              Delivery Boy (optional)
                            </CFormLabel>
                            <CFormSelect
                              size="sm"
                              className="filter-input"
                              value={selectedDeliveryBoy}
                              onChange={(e) => setSelectedDeliveryBoy(e.target.value)}
                            >
                              <option value="">
                                {order.delivery_boy_id
                                  ? 'Keep current assignment'
                                  : 'Not assigned'}
                              </option>
                              {deliveryBoys.map((d) => (
                                <option key={d.id} value={d.id}>
                                  {d.name}
                                </option>
                              ))}
                            </CFormSelect>
                          </div>
                        )}

                        <div className="mb-3">
                          <CFormLabel className="filter-label">
                            Notes (optional)
                          </CFormLabel>
                          <CFormTextarea
                            className="filter-input"
                            rows={2}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                          />
                        </div>

                        <CButton
                          className="filter-btn filter-btn--primary"
                          onClick={handleAdvance}
                          disabled={updating}
                        >
                          {updating ? <CSpinner size="sm" className="me-2" /> : null}
                          Move to {STATUS_LABELS[nextStatus]}
                        </CButton>
                      </CCardBody>
                    </CCard>
                  )}
                </PermissionGate>

                {order.delivery_boy && (
                  <CCard className="report-shell mb-4">
                    <div className="report-shell__header" style={{ padding: '0.65rem 1rem' }}>
                      <strong style={{ fontSize: '0.95rem' }}>Assigned Delivery Boy</strong>
                    </div>
                    <CCardBody>{order.delivery_boy.name}</CCardBody>
                  </CCard>
                )}

                {history.length > 0 && (
                  <CCard className="report-shell">
                    <div className="report-shell__header" style={{ padding: '0.65rem 1rem' }}>
                      <strong style={{ fontSize: '0.95rem' }}>Status History</strong>
                    </div>
                    <CCardBody className="p-0">
                      <CTable hover responsive bordered className="admin-data-table admin-data-table--preview mb-0">
                        <CTableBody>
                          {history.map((h) => (
                            <CTableRow key={h.id}>
                              <CTableDataCell className="text-start small">
                                {STATUS_LABELS[h.from_status] ?? h.from_status ?? '—'}{' '}
                                →{' '}
                                {STATUS_LABELS[h.to_status] ?? h.to_status ?? '—'}
                                {h.changed_by?.name && (
                                  <span className="text-muted"> by {h.changed_by.name}</span>
                                )}
                              </CTableDataCell>
                              <CTableDataCell className="text-end small text-muted">
                                {formatIsoDateTime(h.created_at)}
                              </CTableDataCell>
                            </CTableRow>
                          ))}
                        </CTableBody>
                      </CTable>
                    </CCardBody>
                  </CCard>
                )}
              </div>
            </div>
          </CCardBody>
        </CCard>
      </div>
    </ErrorBoundary>
  )
}

export default OrderDetail