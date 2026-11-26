import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  CCard, CCardBody, CButton, CTable, CTableHead, CTableRow, CTableHeaderCell,
  CTableBody, CTableDataCell, CBadge, CSpinner, CAlert, CModal, CModalHeader,
  CModalTitle, CModalBody, CModalFooter, CFormInput, CFormSelect, CInputGroup,
  CInputGroupText, CNav, CNavItem, CNavLink, CTabContent, CTabPane, CProgress,
  CProgressBar,
} from '@coreui/react'
import CIcon from '@coreui/icons-react'
import {
  cilPlus, cilSearch, cilPencil, cilTrash, cilGift, cilCheckCircle,
  cilXCircle, cilReload,
} from '@coreui/icons'
import api from '../../api/api'
import PermissionGate from '../../components/PermissionGate'
import GiftCampaignForm from './GiftCampaignForm'
import GiftProductForm from './GiftProductForm'

// ─────────────────────────────────────────────────────────────────────────
// ★ FREE GIFTS — admin page (route /masters/gifts, menu "Free Gifts").
//
// Three tabs:
//   1. Campaigns   — threshold-tier campaigns (single-active rule)
//   2. Gift Products — ₹0 gift variants + their stock (inwarded normally)
//   3. Usage Log   — every order that earned gifts (audit)
//
// Backend: /api/v1/masters/gifts/* (permissions gift.view/create/edit/delete)
// ─────────────────────────────────────────────────────────────────────────

const PER_PAGE = 20

const useDebounced = (value, delay = 350) => {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

const money = (n) => `₹${Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

const fmtDate = (d) => d
  ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  : '—'

const fmtDateTime = (d) => d
  ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—'

const apiError = (err, fallback = 'Something went wrong. Please try again.') => {
  const d = err?.response?.data
  if (d?.errors) return Object.values(d.errors).flat().join(' ')
  if (d?.message) return d.message
  if (!err?.response) return 'Network error — please check your connection.'
  return fallback
}

const ORDER_STATUS_COLORS = {
  placed: 'info',
  confirmed: 'primary',
  preparing: 'warning',
  out_for_delivery: 'warning',
  picked_up: 'warning',
  delivered: 'success',
  cancelled: 'danger',
}

const GiftThumb = ({ url, name, size = 40 }) => {
  if (url) {
    return (
      <img
        src={url}
        alt={name || 'gift'}
        width={size}
        height={size}
        style={{ objectFit: 'cover' }}
        className="rounded"
      />
    )
  }
  return (
    <div
      className="d-inline-flex align-items-center justify-content-center rounded bg-light text-medium-emphasis"
      style={{ width: size, height: size }}
    >
      <CIcon icon={cilGift} />
    </div>
  )
}

const Pager = ({ meta, onPage, loading }) => (
  <div className="d-flex flex-wrap justify-content-between align-items-center mt-3 gap-2">
    <span className="small text-medium-emphasis">
      {meta
        ? `${meta.total} record${meta.total === 1 ? '' : 's'} · page ${meta.current_page} of ${meta.last_page}`
        : ''}
    </span>
    <div className="d-flex gap-2">
      <CButton
        size="sm"
        className="filter-btn filter-btn--ghost"
        disabled={!meta || meta.current_page <= 1 || loading}
        onClick={() => onPage(meta.current_page - 1)}
      >
        Previous
      </CButton>
      <CButton
        size="sm"
        className="filter-btn filter-btn--ghost"
        disabled={!meta || meta.current_page >= meta.last_page || loading}
        onClick={() => onPage(meta.current_page + 1)}
      >
        Next
      </CButton>
    </div>
  </div>
)

const EmptyRow = ({ colSpan, children }) => (
  <CTableRow>
    <CTableDataCell colSpan={colSpan} className="text-center text-medium-emphasis py-4">
      {children}
    </CTableDataCell>
  </CTableRow>
)

const FreeGifts = () => {
  const [tab, setTab] = useState('campaigns')

  // ── Campaigns tab state ───────────────────────────────────────────
  const [campaigns, setCampaigns]       = useState([])
  const [campaignsMeta, setCampaignsMeta] = useState(null)
  const [campaignsLoading, setCampaignsLoading] = useState(false)
  const [campaignSearch, setCampaignSearch] = useState('')
  const [campaignActive, setCampaignActive] = useState('')
  const [campaignPage, setCampaignPage] = useState(1)
  const debouncedCampaignSearch = useDebounced(campaignSearch)

  // ── Gift products tab state ───────────────────────────────────────
  const [products, setProducts]       = useState([])
  const [productsMeta, setProductsMeta] = useState(null)
  const [productsLoading, setProductsLoading] = useState(false)
  const [productSearch, setProductSearch] = useState('')
  const [productPage, setProductPage] = useState(1)
  const debouncedProductSearch = useDebounced(productSearch)

  // ── Usage tab state ───────────────────────────────────────────────
  const [usages, setUsages]       = useState([])
  const [usagesMeta, setUsagesMeta] = useState(null)
  const [usagesLoading, setUsagesLoading] = useState(false)
  const [usageSearch, setUsageSearch] = useState('')
  const [usageCampaign, setUsageCampaign] = useState('')
  const [usagePage, setUsagePage] = useState(1)
  const [campaignFilterOptions, setCampaignFilterOptions] = useState([])
  const debouncedUsageSearch = useDebounced(usageSearch)

  // ── Page-level feedback ───────────────────────────────────────────
  const [notice, setNotice] = useState(null)
  const [error, setError]   = useState(null)

  // ── Modals ────────────────────────────────────────────────────────
  const [campaignForm, setCampaignForm] = useState({ open: false, campaign: null })
  const [productForm, setProductForm]   = useState({ open: false, product: null })
  const [toggleModal, setToggleModal]   = useState({ open: false, campaign: null })
  const [toggleError, setToggleError]   = useState(null)
  const [deleteModal, setDeleteModal]   = useState({ open: false, campaign: null })
  const [deleteError, setDeleteError]   = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(t)
  }, [notice])

  // ── Data fetching ─────────────────────────────────────────────────
  const fetchCampaigns = async () => {
    setCampaignsLoading(true)
    setError(null)
    try {
      const res = await api.get('/masters/gifts', {
        params: {
          page: campaignPage,
          per_page: PER_PAGE,
          search: debouncedCampaignSearch || undefined,
          is_active: campaignActive === '' ? undefined : campaignActive,
        },
      })
      setCampaigns(res.data?.data?.data ?? [])
      setCampaignsMeta(res.data?.data?.meta ?? null)
    } catch (err) {
      setError(apiError(err, 'Failed to load gift campaigns.'))
    } finally {
      setCampaignsLoading(false)
    }
  }

  const fetchProducts = async () => {
    setProductsLoading(true)
    setError(null)
    try {
      const res = await api.get('/masters/gifts/products', {
        params: {
          page: productPage,
          per_page: PER_PAGE,
          search: debouncedProductSearch || undefined,
        },
      })
      setProducts(res.data?.data?.data ?? [])
      setProductsMeta(res.data?.data?.meta ?? null)
    } catch (err) {
      setError(apiError(err, 'Failed to load gift products.'))
    } finally {
      setProductsLoading(false)
    }
  }

  const fetchUsages = async () => {
    setUsagesLoading(true)
    setError(null)
    try {
      const res = await api.get('/masters/gifts/usage', {
        params: {
          page: usagePage,
          per_page: PER_PAGE,
          search: debouncedUsageSearch || undefined,
          campaign_id: usageCampaign || undefined,
        },
      })
      setUsages(res.data?.data?.data ?? [])
      setUsagesMeta(res.data?.data?.meta ?? null)
    } catch (err) {
      setError(apiError(err, 'Failed to load the gift usage log.'))
    } finally {
      setUsagesLoading(false)
    }
  }

  useEffect(() => {
    if (tab === 'campaigns') fetchCampaigns()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, campaignPage, debouncedCampaignSearch, campaignActive])

  useEffect(() => {
    if (tab === 'products') fetchProducts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, productPage, debouncedProductSearch])

  useEffect(() => {
    if (tab === 'usage') fetchUsages()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, usagePage, debouncedUsageSearch, usageCampaign])

  // Campaign options for the usage filter (loads once per usage-tab entry).
  useEffect(() => {
    if (tab !== 'usage') return
    let cancelled = false
    const load = async () => {
      try {
        const res = await api.get('/masters/gifts', { params: { per_page: 100 } })
        if (!cancelled) setCampaignFilterOptions(res.data?.data?.data ?? [])
      } catch { /* silent — filter stays empty */ }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // ── Actions ───────────────────────────────────────────────────────
  const doToggleCampaign = async () => {
    const c = toggleModal.campaign
    if (!c) return
    setBusy(true)
    setToggleError(null)
    try {
      const res = await api.patch(`/masters/gifts/${c.id}/toggle`)
      setNotice(res.data?.message || 'Campaign updated.')
      setToggleModal({ open: false, campaign: null })
      fetchCampaigns()
    } catch (err) {
      setToggleError(apiError(err))
    } finally {
      setBusy(false)
    }
  }

  const doDeleteCampaign = async () => {
    const c = deleteModal.campaign
    if (!c) return
    setBusy(true)
    setDeleteError(null)
    try {
      const res = await api.delete(`/masters/gifts/${c.id}`)
      setNotice(res.data?.message || 'Campaign deleted.')
      setDeleteModal({ open: false, campaign: null })
      fetchCampaigns()
    } catch (err) {
      setDeleteError(apiError(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleProduct = async (p) => {
    try {
      const res = await api.patch(`/masters/gifts/products/${p.id}/toggle`)
      setNotice(res.data?.message || 'Gift product updated.')
      fetchProducts()
    } catch (err) {
      setError(apiError(err))
    }
  }

  const activeCampaign = campaigns.find(c => c.is_active)
  const sortedTiers = (c) => [...(c.tiers ?? [])].sort(
    (a, b) => Number(a.threshold_amount) - Number(b.threshold_amount)
  )

  const campaignStatus = (c) => {
    if (c.is_active && c.is_expired) return <CBadge color="warning" shape="rounded-pill">Active · window ended</CBadge>
    if (c.is_active) return <CBadge color="success" shape="rounded-pill">Active</CBadge>
    return <CBadge color="secondary" shape="rounded-pill">Inactive</CBadge>
  }

  // ── Render ────────────────────────────────────────────────────────
  return (
    <>
      <CCard className="report-shell">
        <div className="report-shell__header">
          <h4 className="report-shell__title">
            <CIcon icon={cilGift} className="me-2" />
            Free Gifts
          </h4>
          <span className="text-medium-emphasis small">
            Customers earn gifts when their cart crosses admin-defined thresholds.
          </span>
        </div>

        {(notice || error) && (
          <div className="report-shell__error">
            {notice && (
              <CAlert color="success" dismissible onClose={() => setNotice(null)}>{notice}</CAlert>
            )}
            {error && (
              <CAlert color="danger" dismissible onClose={() => setError(null)}>{error}</CAlert>
            )}
          </div>
        )}

        <CCardBody className="p-0">
          <CNav variant="tabs" className="px-3 pt-2">
            <CNavItem>
              <CNavLink
                active={tab === 'campaigns'}
                style={{ cursor: 'pointer' }}
                onClick={(e) => { e.preventDefault(); setTab('campaigns') }}
              >
                Campaigns
              </CNavLink>
            </CNavItem>
            <CNavItem>
              <CNavLink
                active={tab === 'products'}
                style={{ cursor: 'pointer' }}
                onClick={(e) => { e.preventDefault(); setTab('products') }}
              >
                Gift Products
              </CNavLink>
            </CNavItem>
            <CNavItem>
              <CNavLink
                active={tab === 'usage'}
                style={{ cursor: 'pointer' }}
                onClick={(e) => { e.preventDefault(); setTab('usage') }}
              >
                Usage Log
              </CNavLink>
            </CNavItem>
          </CNav>

          <CTabContent className="p-3">
            {/* ═══════════════ TAB 1 — CAMPAIGNS ═══════════════ */}
            <CTabPane role="tabpanel" visible={tab === 'campaigns'}>
              <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
                <CInputGroup size="sm" style={{ maxWidth: 280 }}>
                  <CInputGroupText><CIcon icon={cilSearch} /></CInputGroupText>
                  <CFormInput
                    className="filter-input"
                    placeholder="Search campaigns"
                    value={campaignSearch}
                    onChange={(e) => { setCampaignSearch(e.target.value); setCampaignPage(1) }}
                  />
                </CInputGroup>
                <CFormSelect
                  size="sm"
                  className="filter-input"
                  style={{ maxWidth: 160 }}
                  value={campaignActive}
                  onChange={(e) => { setCampaignActive(e.target.value); setCampaignPage(1) }}
                >
                  <option value="">All statuses</option>
                  <option value="1">Active</option>
                  <option value="0">Inactive</option>
                </CFormSelect>
                <PermissionGate permission="gift.create">
                  <CButton
                    size="sm"
                    className="report-shell__export ms-auto"
                    onClick={() => setCampaignForm({ open: true, campaign: null })}
                  >
                    <CIcon icon={cilPlus} className="me-2" />New Campaign
                  </CButton>
                </PermissionGate>
              </div>

              {campaignsLoading && !campaigns.length ? (
                <div className="text-center py-5"><CSpinner /></div>
              ) : (
                <>
                  <CTable hover responsive bordered className="admin-data-table">
                    <CTableHead>
                      <CTableRow>
                        <CTableHeaderCell>Campaign</CTableHeaderCell>
                        <CTableHeaderCell>Status</CTableHeaderCell>
                        <CTableHeaderCell>Validity</CTableHeaderCell>
                        <CTableHeaderCell>Tiers</CTableHeaderCell>
                        <CTableHeaderCell>Usage</CTableHeaderCell>
                        <CTableHeaderCell>Actions</CTableHeaderCell>
                      </CTableRow>
                    </CTableHead>
                    <CTableBody>
                      {campaigns.length === 0 && (
                        <EmptyRow colSpan={6}>
                          No campaigns yet — create one, add tiers with gifts, then activate it.
                        </EmptyRow>
                      )}
                      {campaigns.map((c) => (
                        <CTableRow key={c.id}>
                          <CTableDataCell>
                            <div className="fw-semibold">{c.name}</div>
                            <div className="small text-medium-emphasis">
                              {c.tier_mode === 'cumulative' ? 'Cumulative' : 'Exact tiers'} ·{' '}
                              {c.threshold_basis === 'after_coupon' ? 'after coupon' : 'before coupon'}
                            </div>
                          </CTableDataCell>
                          <CTableDataCell>{campaignStatus(c)}</CTableDataCell>
                          <CTableDataCell>
                            <div className="small">
                              {fmtDate(c.valid_from)} → {c.valid_until ? fmtDate(c.valid_until) : 'No end'}
                            </div>
                            {c.is_expired && (
                              <CBadge color="danger" shape="rounded-pill">Ended</CBadge>
                            )}
                          </CTableDataCell>
                          <CTableDataCell style={{ minWidth: 160 }}>
                            {sortedTiers(c).map((t) => {
                              const qty = (t.items ?? []).reduce((s, i) => s + (i.quantity || 0), 0)
                              const names = (t.items ?? []).map((i) => `${i.quantity}× ${i.product_name}`).join(', ')
                              return (
                                <CBadge
                                  key={t.id}
                                  color="info"
                                  shape="rounded-pill"
                                  className="me-1 mb-1"
                                  title={names}
                                >
                                  ₹{Number(t.threshold_amount)} → {qty}
                                </CBadge>
                              )
                            })}
                          </CTableDataCell>
                          <CTableDataCell style={{ minWidth: 130 }}>
                            <div className="small">
                              {c.used_count ?? 0}
                              {c.usage_limit_total ? ` / ${c.usage_limit_total}` : ' · no limit'}
                            </div>
                            {c.usage_limit_total ? (
                              <CProgress className="mt-1" style={{ height: 4 }}>
                                <CProgressBar
                                  color={(c.used_count ?? 0) >= c.usage_limit_total ? 'danger' : 'success'}
                                  value={Math.min(100, ((c.used_count ?? 0) / c.usage_limit_total) * 100)}
                                />
                              </CProgress>
                            ) : null}
                          </CTableDataCell>
                          <CTableDataCell>
                            <div className="d-flex gap-1 justify-content-center">
                              <PermissionGate permission="gift.edit">
                                <CButton
                                  size="sm"
                                  className="table-action-btn"
                                  onClick={() => setCampaignForm({ open: true, campaign: c })}
                                  title="Edit campaign & tiers"
                                >
                                  <CIcon icon={cilPencil} />
                                </CButton>
                                <CButton
                                  size="sm"
                                  className="table-action-btn"
                                  onClick={() => { setToggleError(null); setToggleModal({ open: true, campaign: c }) }}
                                  title={c.is_active ? 'Deactivate' : 'Activate'}
                                >
                                  <CIcon icon={c.is_active ? cilXCircle : cilCheckCircle} />
                                </CButton>
                              </PermissionGate>
                              <PermissionGate permission="gift.delete">
                                <CButton
                                  size="sm"
                                  className="table-action-btn"
                                  onClick={() => { setDeleteError(null); setDeleteModal({ open: true, campaign: c }) }}
                                  title="Delete"
                                >
                                  <CIcon icon={cilTrash} />
                                </CButton>
                              </PermissionGate>
                            </div>
                          </CTableDataCell>
                        </CTableRow>
                      ))}
                    </CTableBody>
                  </CTable>
                  <Pager
                    meta={campaignsMeta}
                    loading={campaignsLoading}
                    onPage={setCampaignPage}
                  />
                </>
              )}
            </CTabPane>

            {/* ═══════════════ TAB 2 — GIFT PRODUCTS ═══════════════ */}
            <CTabPane role="tabpanel" visible={tab === 'products'}>
              <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
                <CInputGroup size="sm" style={{ maxWidth: 280 }}>
                  <CInputGroupText><CIcon icon={cilSearch} /></CInputGroupText>
                  <CFormInput
                    className="filter-input"
                    placeholder="Search gift products (name / SKU)"
                    value={productSearch}
                    onChange={(e) => { setProductSearch(e.target.value); setProductPage(1) }}
                  />
                </CInputGroup>
                <PermissionGate permission="gift.create">
                  <CButton
                    size="sm"
                    className="report-shell__export ms-auto"
                    onClick={() => setProductForm({ open: true, product: null })}
                  >
                    <CIcon icon={cilPlus} className="me-2" />New Gift Product
                  </CButton>
                </PermissionGate>
              </div>

              {productsLoading && !products.length ? (
                <div className="text-center py-5"><CSpinner /></div>
              ) : (
                <>
                  <CTable hover responsive bordered className="admin-data-table">
                    <CTableHead>
                      <CTableRow>
                        <CTableHeaderCell>Product</CTableHeaderCell>
                        <CTableHeaderCell>SKU</CTableHeaderCell>
                        <CTableHeaderCell>MRP</CTableHeaderCell>
                        <CTableHeaderCell>Cost</CTableHeaderCell>
                        <CTableHeaderCell>Stock</CTableHeaderCell>
                        <CTableHeaderCell>Status</CTableHeaderCell>
                        <CTableHeaderCell>Actions</CTableHeaderCell>
                      </CTableRow>
                    </CTableHead>
                    <CTableBody>
                      {products.length === 0 && (
                        <EmptyRow colSpan={7}>
                          No gift products yet — create one, inward its stock, then attach it to a
                          campaign tier.
                        </EmptyRow>
                      )}
                      {products.map((p) => (
                        <CTableRow key={p.id}>
                          <CTableDataCell>
                            <div className="d-flex align-items-center gap-2">
                              <GiftThumb url={p.image_url} name={p.name} />
                              <div>
                                <div className="fw-semibold">
                                  {p.name}{' '}
                                  <CBadge color="warning" shape="rounded-pill" className="ms-1">GIFT</CBadge>
                                </div>
                                <div className="small text-medium-emphasis">{p.category || 'Gifts'}</div>
                              </div>
                            </div>
                          </CTableDataCell>
                          <CTableDataCell>{p.sku}</CTableDataCell>
                          <CTableDataCell>
                            {money(p.mrp)}{p.unit_abbr ? <span className="text-medium-emphasis small"> / {p.unit_abbr}</span> : null}
                          </CTableDataCell>
                          <CTableDataCell>
                            {p.purchase_price !== null && p.purchase_price !== undefined ? money(p.purchase_price) : '—'}
                          </CTableDataCell>
                          <CTableDataCell>
                            <div>
                              <span className={p.available_stock > 0 ? 'fw-semibold' : 'fw-semibold text-danger'}>
                                {p.available_stock}
                              </span>{' '}
                              <span className="text-medium-emphasis small">avail / {p.total_stock} total</span>
                            </div>
                            {p.available_stock === 0 && (
                              <div className="small text-medium-emphasis">
                                <CIcon icon={cilReload} className="me-1" />
                                Inward stock to use in campaigns
                              </div>
                            )}
                          </CTableDataCell>
                          <CTableDataCell>
                            <CBadge
                              color={p.is_active ? 'success' : 'secondary'}
                              shape="rounded-pill"
                              style={{ cursor: 'pointer' }}
                              onClick={() => toggleProduct(p)}
                            >
                              {p.is_active ? 'Active' : 'Inactive'}
                            </CBadge>
                          </CTableDataCell>
                          <CTableDataCell>
                            <div className="d-flex gap-1 justify-content-center">
                              <PermissionGate permission="gift.edit">
                                <CButton
                                  size="sm"
                                  className="table-action-btn"
                                  onClick={() => setProductForm({ open: true, product: p })}
                                  title="Edit gift product"
                                >
                                  <CIcon icon={cilPencil} />
                                </CButton>
                              </PermissionGate>
                            </div>
                          </CTableDataCell>
                        </CTableRow>
                      ))}
                    </CTableBody>
                  </CTable>
                  <Pager
                    meta={productsMeta}
                    loading={productsLoading}
                    onPage={setProductPage}
                  />
                </>
              )}
            </CTabPane>

            {/* ═══════════════ TAB 3 — USAGE LOG ═══════════════ */}
            <CTabPane role="tabpanel" visible={tab === 'usage'}>
              <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
                <CInputGroup size="sm" style={{ maxWidth: 280 }}>
                  <CInputGroupText><CIcon icon={cilSearch} /></CInputGroupText>
                  <CFormInput
                    className="filter-input"
                    placeholder="Search customer / order number"
                    value={usageSearch}
                    onChange={(e) => { setUsageSearch(e.target.value); setUsagePage(1) }}
                  />
                </CInputGroup>
                <CFormSelect
                  size="sm"
                  className="filter-input"
                  style={{ maxWidth: 240 }}
                  value={usageCampaign}
                  onChange={(e) => { setUsageCampaign(e.target.value); setUsagePage(1) }}
                >
                  <option value="">All campaigns</option>
                  {campaignFilterOptions.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </CFormSelect>
              </div>

              {usagesLoading && !usages.length ? (
                <div className="text-center py-5"><CSpinner /></div>
              ) : (
                <>
                  <CTable hover responsive bordered className="admin-data-table">
                    <CTableHead>
                      <CTableRow>
                        <CTableHeaderCell>Date</CTableHeaderCell>
                        <CTableHeaderCell>Customer</CTableHeaderCell>
                        <CTableHeaderCell>Order</CTableHeaderCell>
                        <CTableHeaderCell>Campaign</CTableHeaderCell>
                        <CTableHeaderCell>Gifts Given</CTableHeaderCell>
                      </CTableRow>
                    </CTableHead>
                    <CTableBody>
                      {usages.length === 0 && (
                        <EmptyRow colSpan={5}>
                          No gifts have been given yet — this log fills up as customers earn gifts
                          on their orders.
                        </EmptyRow>
                      )}
                      {usages.map((u) => (
                        <CTableRow key={u.id}>
                          <CTableDataCell>
                            <div className="small">{fmtDateTime(u.used_at)}</div>
                            {/* Released: the order expired or its payment failed,
                                so this gift was never handed over and no longer
                                counts towards any cap. */}
                            {u.released_at && (
                              <CBadge color="secondary" className="mt-1" title={`Released ${fmtDateTime(u.released_at)}`}>
                                released
                              </CBadge>
                            )}
                          </CTableDataCell>
                          <CTableDataCell>
                            <div className="fw-semibold">{u.customer?.name || '—'}</div>
                            <div className="small text-medium-emphasis">{u.customer?.phone || ''}</div>
                          </CTableDataCell>
                          <CTableDataCell>
                            {u.order ? (
                              <>
                                <div className="fw-semibold">
                                  {/* If your order detail route differs (e.g. /orders/:orderNumber), adjust here. */}
                                  <Link to={`/orders/${u.order.id}`}>#{u.order.order_number}</Link>
                                </div>
                                <div className="small text-medium-emphasis">
                                  {money(u.order.total)} ·{' '}
                                  <CBadge color={ORDER_STATUS_COLORS[u.order.status] || 'secondary'}>
                                    {(u.order.status || '').replace(/_/g, ' ')}
                                  </CBadge>
                                </div>
                              </>
                            ) : '—'}
                          </CTableDataCell>
                          <CTableDataCell><div className="small">{u.campaign?.name || '—'}</div></CTableDataCell>
                          <CTableDataCell>
                            {(u.items ?? []).map((i, idx) => (
                              <div key={idx} className="small">
                                {i.quantity} × {i.name}{' '}
                                <span className="text-medium-emphasis">({i.sku})</span>
                              </div>
                            ))}
                          </CTableDataCell>
                        </CTableRow>
                      ))}
                    </CTableBody>
                  </CTable>
                  <Pager
                    meta={usagesMeta}
                    loading={usagesLoading}
                    onPage={setUsagePage}
                  />
                </>
              )}
            </CTabPane>
          </CTabContent>
        </CCardBody>
      </CCard>

      {/* ── Forms ─────────────────────────────────────────────────── */}
      <GiftCampaignForm
        open={campaignForm.open}
        campaign={campaignForm.campaign}
        onClose={() => setCampaignForm({ open: false, campaign: null })}
        onSaved={(msg) => {
          setCampaignForm({ open: false, campaign: null })
          setNotice(msg)
          fetchCampaigns()
        }}
      />

      <GiftProductForm
        open={productForm.open}
        product={productForm.product}
        onClose={() => setProductForm({ open: false, product: null })}
        onSaved={(msg) => {
          setProductForm({ open: false, product: null })
          setNotice(msg)
          fetchProducts()
        }}
      />

      {/* ── Activate / deactivate confirm ─────────────────────────── */}
      <CModal
        visible={toggleModal.open}
        onClose={() => setToggleModal({ open: false, campaign: null })}
        backdrop="static"
      >
        <CModalHeader>
          <CModalTitle>
            {toggleModal.campaign?.is_active ? 'Deactivate campaign?' : 'Activate campaign?'}
          </CModalTitle>
        </CModalHeader>
        <CModalBody>
          {toggleError && (
            <CAlert color="danger" dismissible onClose={() => setToggleError(null)}>
              {toggleError}
            </CAlert>
          )}
          {toggleModal.campaign?.is_active ? (
            <p className="mb-0">
              Customers will immediately stop earning gifts from{' '}
              <strong>“{toggleModal.campaign?.name}”</strong>. The campaign and its tiers are kept.
            </p>
          ) : (
            <>
              <p className="mb-2">
                <strong>“{toggleModal.campaign?.name}”</strong> will go live — customers start
                earning gifts as soon as their cart crosses the tier thresholds.
              </p>
              {activeCampaign && activeCampaign.id !== toggleModal.campaign?.id && (
                <CAlert color="warning" className="mb-0">
                  <strong>“{activeCampaign.name}”</strong> is currently active and will be
                  deactivated — only one campaign can run at a time.
                </CAlert>
              )}
            </>
          )}
        </CModalBody>
        <CModalFooter>
          <CButton
            className="filter-btn filter-btn--ghost"
            onClick={() => setToggleModal({ open: false, campaign: null })}
            disabled={busy}
          >
            Cancel
          </CButton>
          <CButton
            className="filter-btn filter-btn--primary"
            onClick={doToggleCampaign}
            disabled={busy}
          >
            {busy && <CSpinner size="sm" className="me-2" />}
            {toggleModal.campaign?.is_active ? 'Deactivate' : 'Activate'}
          </CButton>
        </CModalFooter>
      </CModal>

      {/* ── Delete confirm ────────────────────────────────────────── */}
      <CModal
        visible={deleteModal.open}
        onClose={() => setDeleteModal({ open: false, campaign: null })}
        backdrop="static"
      >
        <CModalHeader>
          <CModalTitle>Delete campaign?</CModalTitle>
        </CModalHeader>
        <CModalBody>
          {deleteError && (
            <CAlert color="danger" dismissible onClose={() => setDeleteError(null)}>
              {deleteError}
            </CAlert>
          )}
          <p className="mb-0">
            This permanently removes <strong>“{deleteModal.campaign?.name}”</strong> and all of
            its tiers. Campaigns that have already gifted orders cannot be deleted — deactivate
            those instead.
          </p>
        </CModalBody>
        <CModalFooter>
          <CButton
            className="filter-btn filter-btn--ghost"
            onClick={() => setDeleteModal({ open: false, campaign: null })}
            disabled={busy}
          >
            Cancel
          </CButton>
          <CButton className="filter-btn filter-btn--primary" onClick={doDeleteCampaign} disabled={busy}>
            {busy && <CSpinner size="sm" className="me-2" />}
            Delete
          </CButton>
        </CModalFooter>
      </CModal>
    </>
  )
}

export default FreeGifts
