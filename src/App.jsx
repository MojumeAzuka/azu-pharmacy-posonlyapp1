import React, { useState, useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  db,
  supabase,
  hasRole,
  syncDrugsFromCloud,
  syncPendingDrugsToCloud,
  syncPendingSalesToCloud,
  syncAuditLogToCloud,
  fetchCloudAuditLog,
  pruneSalesOlderThanOneYear,
  softDeleteDrug,
  restoreDrug,
  permanentlyDeleteDrug,
  bulkDeleteSalesByDateRange,
  reverseSaleItems,
  syncPendingReversalsToCloud,
  requestSaleReversal,
  fetchCloudReversalRequests,
  syncPendingReversalRequestsToCloud,
  approveReversalRequest,
  rejectReversalRequest,
  createTicket,
  fetchCloudTickets,
  fetchLiveTickets,
  bulkImportSuppliers,
  bulkImportCustomers,
  bulkImportBankOptions,
  fetchProfileDirectory,
  readCachedProfileDirectory,
  createAccount,
  updateAccountDetails,
  setAccountPassword,
  setAccountActive,
  pushDrugStockDelta,
  applyRealtimeTicketRow,
  applyRealtimeDrugRow,
  syncPendingTicketsToCloud,
  expireStaleTickets,
  cancelTicket,
  approveTicket,
  sendTicketBack,
  resubmitTicket,
  clampNegativeStockToZero,
  fetchBankOptions,
  addBankOption,
  removeBankOption,
  updateBankOption,
  syncPendingBankOptionsToCloud,
  logAuditEvent,
  fetchSuppliers,
  addSupplier,
  syncPendingSuppliersToCloud,
  createStockEntry,
  approveStockEntry,
  rejectStockEntry,
  fetchCloudStockEntries,
  syncPendingStockEntriesToCloud,
  editStockEntry,
  approveStockEntryEdit,
  rejectStockEntryEdit,
  fetchCloudStockEntryEdits,
  syncPendingStockEntryEditsToCloud,
  STOCK_ENTRY_EDIT_WINDOW_DAYS,
  getRestockDraft,
  saveRestockDraft,
  clearRestockDraft,
  updateSupplier,
  softDeleteSupplier,
  requestDeleteSupplier,
  restoreSupplier,
  permanentlyDeleteSupplier,
  approveSupplierChangeRequest,
  rejectSupplierChangeRequest,
  fetchCloudSupplierChangeRequests,
  syncPendingSupplierChangeRequestsToCloud,
  recordSupplierPayment,
  requestDrugEdit,
  requestDeleteDrug,
  approveDrugChangeRequest,
  rejectDrugChangeRequest,
  fetchCloudDrugChangeRequests,
  syncPendingDrugChangeRequestsToCloud,
  getPriceRecommendation,
  recordDrugPriceChoice,
  fetchCloudPurchasePlans,
  syncPendingPurchasePlansToCloud,
  savePurchasePlan,
  fetchCustomers,
  addCustomer,
  syncPendingCustomersToCloud,
  updateCustomer,
  softDeleteCustomer,
  requestDeleteCustomer,
  restoreCustomer,
  permanentlyDeleteCustomer,
  approveCustomerChangeRequest,
  rejectCustomerChangeRequest,
  fetchCloudCustomerChangeRequests,
  syncPendingCustomerChangeRequestsToCloud,
  getMinimumWholesalePayment,
  DEFAULT_PRICING_SETTINGS,
  fetchPricingSettings,
  savePricingSettings,
  bulkImportDrugs,
  fetchAllProfiles,
  updateUserRole,
  saveCartDraft,
  fetchSavedCartDrafts,
  deleteCartDraft,
  linkCustomerToTicket
} from './db';
import './App.css';

const LAST_SEEN_AUDIT_KEY = 'azu_last_seen_manager_changes';

// A small, self-contained "as you type the cost price" suggestion —
// pure/stateless, driven entirely by props, so it can drop into any
// cost-price field (the Drugs CRUD form, a restock line) without
// knowing anything about where it's being used. Renders nothing when
// the cost price isn't a usable number yet.
function PriceRecommendationHint({ costPrice, priceHistory, settings, onPickWholesale, onPickRetail }) {
  const rec = getPriceRecommendation(costPrice, priceHistory, settings);
  if (!rec) return null;

  const learnedNote = rec.source === 'learned' ? ' · based on your past prices for this drug' : '';

  if (rec.sameForBoth) {
    return (
      <div className="price-recommendation-hint">
        <button
          type="button"
          className="price-rec-chip"
          onClick={() => {
            onPickWholesale(rec.wholesale);
            onPickRetail(rec.retail);
          }}
        >
          💡 Suggested price: ₦{rec.wholesale.toLocaleString()} (
          {rec.retailPercent.toFixed(0)}% profit){learnedNote}
        </button>
      </div>
    );
  }

  return (
    <div className="price-recommendation-hint">
      <button type="button" className="price-rec-chip" onClick={() => onPickWholesale(rec.wholesale)}>
        💡 Wholesale ₦{rec.wholesale.toLocaleString()} ({rec.wholesalePercent.toFixed(0)}%)
      </button>
      <button type="button" className="price-rec-chip" onClick={() => onPickRetail(rec.retail)}>
        💡 Retail ₦{rec.retail.toLocaleString()} ({rec.retailPercent.toFixed(0)}%)
      </button>
      {rec.source === 'learned' && (
        <span className="price-rec-source">based on your past prices for this drug</span>
      )}
    </div>
  );
}

export default function App() {
  // ============================================================
  // AUTH STATE
  // ============================================================
  const [session, setSession] = useState(null);
  const [userRole, setUserRole] = useState('salesperson');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState('');
  const [authInfo, setAuthInfo] = useState('');
  // 'login' | 'forgot' — which form the signed-out screen shows.
  const [authView, setAuthView] = useState('login');
  // True while the user arrived from a password-reset email link and
  // still has to choose a new password (the link signs them in
  // temporarily — they must not slip into the app without setting one).
  const [isRecoveringPassword, setIsRecoveringPassword] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);

  // Everyone's full name, so records show "Amaka Obi" instead of an email
  // address. Old emails an account used before a change still resolve to
  // the same person. Falls back to the raw email when no name is set.
  const [profileDirectory, setProfileDirectory] = useState(() =>
    readCachedProfileDirectory()
  );
  const profileNameIndex = React.useMemo(() => {
    const index = new Map();
    (profileDirectory || []).forEach((p) => {
      const name = (p.full_name || '').trim();
      if (!name) return;
      [p.email, ...(Array.isArray(p.previous_emails) ? p.previous_emails : [])]
        .filter(Boolean)
        .forEach((e) => index.set(String(e).toLowerCase(), name));
      index.set(String(p.id), name);
    });
    return index;
  }, [profileDirectory]);
  // "Is this record mine?" — by current email OR any email this account
  // used before an admin changed it, so history stays attached to the
  // person after an email change.
  const myEmailSet = React.useMemo(() => {
    const set = new Set();
    if (session?.user?.email) set.add(session.user.email.toLowerCase());
    const me = (profileDirectory || []).find((p) => p.id === session?.user?.id);
    if (me) {
      [me.email, ...(Array.isArray(me.previous_emails) ? me.previous_emails : [])]
        .filter(Boolean)
        .forEach((e) => set.add(String(e).toLowerCase()));
    }
    return set;
  }, [profileDirectory, session?.user?.id, session?.user?.email]);
  const isMyEmail = (email) =>
    !!email && myEmailSet.has(String(email).toLowerCase());
  const nameOf = (emailOrId) => {
    if (!emailOrId) return emailOrId || '';
    const key = String(emailOrId);
    return profileNameIndex.get(key.toLowerCase()) || profileNameIndex.get(key) || key;
  };

  // ============================================================
  // NAVIGATION
  // ============================================================
  const [activeTab, setActiveTab] = useState('pos'); // 'pos' | 'history' | 'admin'

  // ============================================================
  // POS STATE
  // ============================================================
  const [searchTerm, setSearchTerm] = useState('');
  const [cart, setCart] = useState([]);
  const [saleType, setSaleType] = useState('retail');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');

  // ============================================================
  // RECEIPT STATE
  // ============================================================
  const [saleSuccessData, setSaleSuccessData] = useState(null);
  const [showReceiptModal, setShowReceiptModal] = useState(false);

  // ============================================================
  // NETWORK STATE
  // ============================================================
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  // Holds the latest runAllSync function (defined inside the sync
  // useEffect below) so the separate connectivity-check interval can
  // call it without needing to be in that same effect.
  const runAllSyncRef = useRef(() => {});

  // ============================================================
  // CART LIST REF
  // ============================================================
  const cartListRef = useRef(null);

  // ============================================================
  // MANAGER CRUD MODAL
  // ============================================================
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDrug, setEditingDrug] = useState(null);

  // isSavingDrug drives the button's disabled/"Saving…" state. The ref
  // alongside it is the part that actually stops a double-click:
  // React state updates aren't guaranteed to have re-rendered yet by
  // the time a second, near-instant click fires handleSaveDrug again,
  // but a ref updates synchronously, so the guard at the top of
  // handleSaveDrug can't be raced the way the old code could.
  const [isSavingDrug, setIsSavingDrug] = useState(false);
  const isSavingDrugRef = useRef(false);

  // halfPackQty/halfPackPrice and packQty/packPrice are all optional —
  // most drugs are sold one unit at a time and leave these blank. When
  // a drug does have a pack size filled in, hitting that quantity in the
  // cart switches that portion of the line to the discounted pack price
  // instead of unit price × quantity (see computePackPricing below).
  const [formData, setFormData] = useState({
    name: '',
    unitType: 'Unit',
    costPrice: '',
    retailPrice: '',
    wholesalePrice: '',
    stock: '',
    barcode: '',
    halfPackQty: '',
    halfPackPrice: '',
    packQty: '',
    packPrice: '',
    minStockQty: '',
    recommendedPurchaseQty: '',
    counterSpace: ''
  });

  // Unmissable confirm-delete modal, shared by drugs and suppliers — a
  // deletion (soft-delete either way) never happens off a plain
  // window.confirm() anymore. `deletingTarget` is either
  // { kind: 'drug', item } or { kind: 'supplier', item }, or null when
  // the modal is closed.
  const [deletingTarget, setDeletingTarget] = useState(null);
  const [isDeletingTarget, setIsDeletingTarget] = useState(false);

  // ============================================================
  // DRUGS & SUPPLIERS HUB — one bottom-bar entry point, with its own
  // internal sub-tabs (same pattern as the Administrator screen's
  // adminSection). 'restock' keeps everything that already existed here;
  // the rest are new.
  // ============================================================
  const [catalogSection, setCatalogSection] = useState('restock');

  // --- Suppliers CRUD ---
  const [supplierSearchTerm, setSupplierSearchTerm] = useState('');
  const [isSupplierModalOpen, setIsSupplierModalOpen] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState(null);
  const [isSavingSupplierCrud, setIsSavingSupplierCrud] = useState(false);
  const [supplierFormData, setSupplierFormData] = useState({
    name: '',
    contactPerson: '',
    phone: '',
    email: '',
    address: ''
  });

  // --- Wholesale Customers CRUD ---
  const [customerSearchTerm, setCustomerSearchTerm] = useState('');
  const [isCustomerModalOpen, setIsCustomerModalOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [isSavingCustomerCrud, setIsSavingCustomerCrud] = useState(false);
  const [customerFormData, setCustomerFormData] = useState({
    name: '',
    phones: [''],
    email: '',
    address: ''
  });
  // Set when the "+ New Customer" shortcut was opened from the
  // cashier's approval modal (rather than the standalone Customers
  // screen) — tells handleSaveCustomer to link the result onto
  // approvingTicket once it's actually usable (i.e. a manager/admin
  // created it directly; a cashier's request has to wait for approval
  // first and isn't linked to anything yet).
  const [customerPickerForApproval, setCustomerPickerForApproval] = useState(false);
  // The cashier's "this wholesale customer wants to owe" search box in
  // the approval modal — only relevant for a ticket with no customer
  // linked yet.
  const [isLinkingCustomerForApproval, setIsLinkingCustomerForApproval] = useState(false);
  const [approvalCustomerSearchTerm, setApprovalCustomerSearchTerm] = useState('');

  // --- Drugs CRUD list (separate from the ticket-builder search) ---
  const [drugCrudSearchTerm, setDrugCrudSearchTerm] = useState('');

  // --- Purchase List — a live, continuously-saved per-drug plan, not a
  // generated-then-saved snapshot. Editing a quantity or supplier writes
  // straight to db.purchasePlans; nothing here needs its own "saving"
  // state beyond per-row busy flags.
  const [purchasePlanSearchTerm, setPurchasePlanSearchTerm] = useState('');
  const [showNotToBuyList, setShowNotToBuyList] = useState(false);
  const [supplierPickerForDrugId, setSupplierPickerForDrugId] = useState(null);
  const [printingPurchasePlan, setPrintingPurchasePlan] = useState(null);

  // --- Stock History (separate from the "last 7 days" edit-window list
  // and the 10-item "My Recent Stock Entries" slice already in restock) ---
  const [stockHistorySearchTerm, setStockHistorySearchTerm] = useState('');

  // --- Record-a-payment modal, for a stock entry that's not fully paid ---
  const [recordingPaymentFor, setRecordingPaymentFor] = useState(null);
  const [recordPaymentAmount, setRecordPaymentAmount] = useState('');
  const [isRecordingPayment, setIsRecordingPayment] = useState(false);

  // ============================================================
  // SALES HISTORY
  // ============================================================
  const [historySearchTerm, setHistorySearchTerm] = useState('');
  const [historyCashierFilter, setHistoryCashierFilter] = useState('all');
  const [cloudSales, setCloudSales] = useState([]);

  // Manager partial-sale-reversal modal: which sale is open, and how
  // many units of each line item the manager has chosen to reverse.
  const [reversingSale, setReversingSale] = useState(null);
  const [reversalQtys, setReversalQtys] = useState({});
  const [isReversing, setIsReversing] = useState(false);

  // ============================================================
  // ADMINISTRATOR STATE
  // ============================================================
  const [bulkDeleteStart, setBulkDeleteStart] = useState('');
  const [bulkDeleteEnd, setBulkDeleteEnd] = useState('');
  // Dashboard's custom date-range profit search — left blank until the
  // admin picks a range.
  const [dashboardRangeStart, setDashboardRangeStart] = useState('');
  const [dashboardRangeEnd, setDashboardRangeEnd] = useState('');

  // Admin-editable "general recommended profit %" used by the price
  // recommendation hints everywhere a cost price is entered — starts
  // at the same defaults the pharmacy was already using by hand, and
  // is overwritten as soon as the real saved setting loads.
  const [pricingSettings, setPricingSettings] = useState(DEFAULT_PRICING_SETTINGS);
  const [pricingSettingsForm, setPricingSettingsForm] = useState(DEFAULT_PRICING_SETTINGS);
  const [isSavingPricingSettings, setIsSavingPricingSettings] = useState(false);

  // CSV/Excel drug import — tracks what's about to be imported (a
  // preview) and the result summary after it runs.
  const [importPreviewRows, setImportPreviewRows] = useState(null);
  const [importFileName, setImportFileName] = useState('');
  const [isImportingDrugs, setIsImportingDrugs] = useState(false);
  const [importResultSummary, setImportResultSummary] = useState(null);
  // Data Hub (every other dataset's import/export)
  const [hubDatasetKey, setHubDatasetKey] = useState('suppliers');
  const [hubPreviewRows, setHubPreviewRows] = useState(null);
  const [hubFileName, setHubFileName] = useState('');
  const [hubResult, setHubResult] = useState(null);
  const [isHubBusy, setIsHubBusy] = useState(false);

  // Role management — the list of Supabase auth accounts/profiles,
  // fetched fresh (online-only feature) whenever the admin opens that
  // panel, plus which row is mid-save.
  const [allProfiles, setAllProfiles] = useState(null);
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);
  const [savingProfileId, setSavingProfileId] = useState(null);
  // Account management modal: null | { mode: 'create' } | { mode: 'edit', profile } | { mode: 'password', profile }
  const [accountModal, setAccountModal] = useState(null);
  const [accountForm, setAccountForm] = useState({
    email: '',
    fullName: '',
    password: '',
    role: 'salesperson'
  });
  const [isSavingAccount, setIsSavingAccount] = useState(false);

  const [lastSeenAuditAt, setLastSeenAuditAt] = useState(
    () => localStorage.getItem(LAST_SEEN_AUDIT_KEY) || null
  );

  // Drug-sale accountability search: "who sold this and when" for a
  // named drug, independent of the Sales History tab's own filters.
  const [drugSearchTerm, setDrugSearchTerm] = useState('');

  // Which admin panel is open — defaults to the Audit Log (the thing an
  // admin checks most), with the less-used tools (drug search, recovery,
  // bulk delete, bank options) tucked behind their own buttons instead
  // of all being shown stacked on top of each other at once.
  const [adminSection, setAdminSection] = useState('audit');

  // Audit Log action-type filter — 'all' shows the full list (the
  // default), or narrow to one action like 'drug_added'.
  const [auditActionFilter, setAuditActionFilter] = useState('all');

  // ============================================================
  // ATTENDANT / CASHIER TICKET WORKFLOW
  // ------------------------------------------------------------
  // ticketDrafts: carts an attendant is still building, one per
  // customer, NEVER written to Dexie/Supabase until submitted (this is
  // the DRAFT status — purely local, in-memory). Several can be open
  // at once so one attendant can juggle multiple customers.
  // activeDraftId: which draft the catalog's "tap a drug" adds to.
  // ============================================================
  const [ticketDrafts, setTicketDrafts] = useState([]);
  const [activeDraftId, setActiveDraftId] = useState(null);
  const [isSubmittingTicket, setIsSubmittingTicket] = useState(false);

  // Carts set aside to continue later — persisted locally (see
  // cartDrafts in db.js), loaded fresh whenever the Saved Carts panel
  // is opened and whenever one is saved/resumed/discarded.
  const [savedCartDrafts, setSavedCartDrafts] = useState([]);
  const [isSavedCartsPanelOpen, setIsSavedCartsPanelOpen] = useState(false);
  const [isSavingCartDraft, setIsSavingCartDraft] = useState(false);

  // Briefly highlights whichever item was just tapped into the active
  // draft's cart, and the list auto-scrolls to it — same "see what you
  // just added" behavior the single-cart POS used to have, reapplied to
  // the per-customer draft carts.
  const [lastAddedItemId, setLastAddedItemId] = useState(null);
  const lastAddedTimeoutRef = useRef(null);
  const [stockWarning, setStockWarning] = useState('');
  const stockWarningTimeoutRef = useRef(null);
  const draftCartListRef = useRef(null);

  // Cashier-side: which PENDING_PAYMENT ticket is open in the
  // approve/payment-split modal, and the cash/bank/card amounts and
  // chosen bank being entered for it.
  const [approvingTicket, setApprovingTicket] = useState(null);
  const [paymentCash, setPaymentCash] = useState('');
  // The top-level choice the cashier makes first: Cash is the simple
  // case (no bank involved). Card and Transfer are both "electronic"
  // and each need a bank attached — a card payment still clears through
  // a specific bank account, same as a transfer. Split is the general
  // case: cash plus any number of card/transfer lines, each with its
  // own bank and amount, so a transfer that was genuinely split across
  // two different banks (or a transfer made twice — see the "sent back
  // for one more item, customer transferred again" note below) is just
  // two lines instead of something this form can't represent.
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paymentElectronicLines, setPaymentElectronicLines] = useState([]);
  const [isApprovingTicket, setIsApprovingTicket] = useState(false);

  // Cashier-side: which PENDING_PAYMENT ticket is open in the "send
  // back for adjustment" modal, and the reason being typed for it. A
  // cashier never edits drugs/quantities themselves — this just flags
  // the ticket back to whoever built it, with a note on what to fix.
  const [sendingBackTicket, setSendingBackTicket] = useState(null);
  const [sendBackReason, setSendBackReason] = useState('');
  const [isSendingBackTicket, setIsSendingBackTicket] = useState(false);

  // Admin: new bank-option name being typed into the add box.
  const [newBankOptionName, setNewBankOptionName] = useState('');
  const [newBankOptionColor, setNewBankOptionColor] = useState('#6b7280');

  // The just-submitted ticket shown in the printable "take this to the
  // cashier" slip modal (separate from the receipt modal, which is only
  // for a completed/PAID sale).
  const [printingTicket, setPrintingTicket] = useState(null);

  // ============================================================
  // RESTOCK FROM SUPPLIER
  // A selected existing supplier id, OR the sentinel '__new__' while
  // the inline "new supplier" form is open. restockCart holds the line
  // items being built up before submitting — each one either an
  // existing drug (drugId set, isNewDrug false) or a brand-new one
  // (isNewDrug true, no drugId until submit time).
  // ============================================================
  const [restockSupplierId, setRestockSupplierId] = useState('');
  const [newSupplierForm, setNewSupplierForm] = useState({
    name: '',
    contactPerson: '',
    phone: '',
    email: '',
    address: ''
  });
  const [isSavingSupplier, setIsSavingSupplier] = useState(false);

  const [restockCart, setRestockCart] = useState([]);
  // How much of this stock entry's total cost is being paid to the
  // supplier right now — the rest becomes "owed", tracked per entry and
  // addable to later via recordSupplierPayment.
  const [restockAmountPaid, setRestockAmountPaid] = useState('');
  const [restockSearchTerm, setRestockSearchTerm] = useState('');
  const [showNewDrugForm, setShowNewDrugForm] = useState(false);
  const [newDrugLine, setNewDrugLine] = useState({
    name: '',
    unitType: 'Unit',
    quantity: '',
    costPrice: '',
    retailPrice: '',
    wholesalePrice: '',
    barcode: '',
    // Optional, same as the main "Add Drug" form — a blank slot means
    // "no discounted pack pricing for this drug", not a free pack.
    halfPackQty: '',
    halfPackPrice: '',
    packQty: '',
    packPrice: ''
  });

  const [isSubmittingStockEntry, setIsSubmittingStockEntry] = useState(false);
  const [rejectingStockEntry, setRejectingStockEntry] = useState(null);
  const [stockRejectReason, setStockRejectReason] = useState('');
  const [isRejectingStockEntry, setIsRejectingStockEntry] = useState(false);

  // Editing an already-submitted stock entry (even one already APPLIED)
  // within the edit window — a manager's edit applies immediately, a
  // cashier's edit to their own entry queues for manager approval.
  const [editingStockEntry, setEditingStockEntry] = useState(null);
  const [editStockItems, setEditStockItems] = useState([]);
  const [isSavingStockEdit, setIsSavingStockEdit] = useState(false);

  // Manager reviewing a cashier's pending edit request.
  const [rejectingStockEdit, setRejectingStockEdit] = useState(null);
  const [stockEditRejectReason, setStockEditRejectReason] = useState('');
  const [isRejectingStockEdit, setIsRejectingStockEdit] = useState(false);

  // Manager reviewing a cashier's pending drug or supplier change
  // request (edit or delete) — { kind: 'drug' | 'supplier', request }.
  const [rejectingChangeRequest, setRejectingChangeRequest] = useState(null);
  const [changeRequestRejectReason, setChangeRequestRejectReason] = useState('');
  const [isRejectingChangeRequest, setIsRejectingChangeRequest] = useState(false);
  const [isApprovingChangeRequestId, setIsApprovingChangeRequestId] = useState(null);

  // Whether the restock draft saved for this account has been loaded
  // yet — guards against saving an empty draft over a real one before
  // the load effect has had a chance to run.
  const restockDraftLoadedRef = useRef(false);
  // Which account's draft is currently loaded into the state above —
  // the save effect writes under THIS email, not whatever
  // session?.user?.email happens to read as at save time (those can
  // briefly disagree for one render during an account switch).
  const restockDraftEmailRef = useRef(null);

  const blankNewDrugLine = {
    name: '',
    unitType: 'Unit',
    quantity: '',
    costPrice: '',
    retailPrice: '',
    wholesalePrice: '',
    barcode: '',
    halfPackQty: '',
    halfPackPrice: '',
    packQty: '',
    packPrice: ''
  };

  // Load (or reset) the restock draft whenever the signed-in account
  // changes. The reset happens FIRST and unconditionally — before
  // anything is loaded — so switching from a manager to a cashier login
  // on the same device never shows the manager's in-progress supplier
  // or cart, even for the one render before the cashier's own saved
  // draft (if any) comes back from Dexie.
  useEffect(() => {
    const email = session?.user?.email || null;

    restockDraftLoadedRef.current = false;
    restockDraftEmailRef.current = null;

    setRestockSupplierId('');
    setNewSupplierForm({ name: '', contactPerson: '', phone: '', email: '', address: '' });
    setRestockCart([]);
    setShowNewDrugForm(false);
    setNewDrugLine(blankNewDrugLine);

    if (!email) return;

    let cancelled = false;

    getRestockDraft(email).then((draft) => {
      if (cancelled) return;

      if (draft) {
        if (draft.restockSupplierId) setRestockSupplierId(draft.restockSupplierId);
        if (draft.newSupplierForm) setNewSupplierForm(draft.newSupplierForm);
        if (draft.restockCart) setRestockCart(draft.restockCart);
        if (draft.showNewDrugForm) setShowNewDrugForm(draft.showNewDrugForm);
        if (draft.newDrugLine) setNewDrugLine(draft.newDrugLine);
      }

      // Only now does this account's draft count as "loaded" — the
      // save effect below stays silent until this flips true, so it
      // can never stomp a real saved draft with the blank reset above.
      restockDraftEmailRef.current = email;
      restockDraftLoadedRef.current = true;
    });

    return () => {
      cancelled = true;
    };
  }, [session?.user?.email]);

  // Persist the in-progress restock screen as it's built, so stepping
  // away to attend a customer — or closing the tab entirely — doesn't
  // lose the work. Tied to restockDraftEmailRef (the account whose
  // draft is actually loaded right now), not raw state alone, so it
  // never writes under the wrong account for that one render during a
  // switch.
  useEffect(() => {
    if (!restockDraftLoadedRef.current || !restockDraftEmailRef.current) return;

    const email = restockDraftEmailRef.current;
    const hasContent =
      !!restockSupplierId ||
      restockCart.length > 0 ||
      !!newSupplierForm.name.trim() ||
      showNewDrugForm;

    if (!hasContent) {
      clearRestockDraft(email);
      return;
    }

    saveRestockDraft(email, {
      restockSupplierId,
      newSupplierForm,
      restockCart,
      showNewDrugForm,
      newDrugLine
    });
  }, [restockSupplierId, newSupplierForm, restockCart, showNewDrugForm, newDrugLine]);

  // ============================================================
  // AUTO-SCROLL CART
  // ============================================================
  useEffect(() => {
    if (cart.length > 0 && cartListRef.current) {
      requestAnimationFrame(() => {
        cartListRef.current?.scrollTo({
          top: cartListRef.current.scrollHeight,
          behavior: 'smooth'
        });
      });
    }
  }, [cart]);

  // Same auto-scroll, for the active ticket draft's cart — the item
  // that was just tapped should always be the one in view, not scrolled
  // out of sight above a long list.
  const activeDraftItemCount =
    ticketDrafts.find((d) => d.id === activeDraftId)?.items.length || 0;

  useEffect(() => {
    if (activeDraftItemCount > 0 && draftCartListRef.current) {
      requestAnimationFrame(() => {
        draftCartListRef.current?.scrollTo({
          top: draftCartListRef.current.scrollHeight,
          behavior: 'smooth'
        });
      });
    }
  }, [activeDraftItemCount, activeDraftId]);

  // ============================================================
  // SUPABASE AUTH
  // ============================================================
  useEffect(() => {
    // An expired / already-used reset link comes back as #error=...
    try {
      const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      if (params.get('error_description')) {
        setAuthError(
          'That reset link has expired or was already used. Tap "Forgot your password?" to get a new one.'
        );
        window.history.replaceState(null, '', window.location.pathname);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);

      if (session) {
        fetchUserProfile(session.user.id);
      }
    });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        setIsRecoveringPassword(true);
      }
      setSession(session);

      if (session) {
        fetchUserProfile(session.user.id);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const fetchUserProfile = async (userId) => {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .single();

      if (error) throw error;

      if (data?.role) {
        setUserRole(data.role);
      }
    } catch (err) {
      console.warn(
        'Could not fetch user profile role, defaulting to salesperson:',
        err.message
      );

      setUserRole('salesperson');
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setAuthError('');

    const { error } = await supabase.auth.signInWithPassword({
      email: loginEmail,
      password: loginPassword
    });

    if (error) {
      setAuthError(error.message);
    }
  };

  const handleSendPasswordReset = async (e) => {
    e.preventDefault();
    setAuthError('');
    setAuthInfo('');

    const email = loginEmail.trim();
    if (!email) {
      setAuthError('Enter your email address first.');
      return;
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin
    });

    if (error) {
      setAuthError(error.message);
      return;
    }

    // Same message whether or not the address exists, so this form can't
    // be used to discover which emails have accounts.
    setAuthInfo(
      'If that email has an account, a password reset link is on its way. Open it on this device and choose a new password.'
    );
  };

  const handleSaveNewPassword = async (e) => {
    e.preventDefault();
    setAuthError('');

    if (newPassword.length < 8) {
      setAuthError('Use at least 8 characters.');
      return;
    }
    if (newPassword !== confirmNewPassword) {
      setAuthError('The two passwords do not match.');
      return;
    }

    setIsSavingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setIsSavingPassword(false);

    if (error) {
      setAuthError(error.message);
      return;
    }

    setNewPassword('');
    setConfirmNewPassword('');
    setIsRecoveringPassword(false);
    setShowChangePassword(false);
    // Drop the #access_token… recovery fragment from the address bar.
    window.history.replaceState(null, '', window.location.pathname);
    alert('Password updated.');
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setCart([]);
    setSession(null);
  };

  // ============================================================
  // CLOUD SALES
  // ============================================================
  // Supabase/PostgREST caps every request at 1000 rows by default. At
  // 200-250 sales a day that's only about 4 days' worth of sales — a
  // plain .select('*') would silently drop everything older than that
  // from what a manager sees in Sales History. This pages through with
  // .range() until a page comes back short, with SALES_FETCH_MAX_PAGES
  // as a hard ceiling so one very old, very busy project can't trigger
  // an unbounded fetch.
  const SALES_FETCH_PAGE_SIZE = 1000;
  const SALES_FETCH_MAX_PAGES = 100; // up to 100,000 rows — comfortably more than a year of sales at this volume

  const fetchCloudSales = async () => {
    if (!navigator.onLine || !session) return;

    try {
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

      let allSales = [];
      let from = 0;
      let page = 0;

      while (page < SALES_FETCH_MAX_PAGES) {
        let query = supabase
          .from('sales')
          .select('*')
          .gte('created_at', oneYearAgo.toISOString())
          .order('created_at', { ascending: false })
          .range(from, from + SALES_FETCH_PAGE_SIZE - 1);

        // Same visibility rule as the local query above: manager/admin
        // see everything, a cashier sees what THEY closed, a
        // salesperson sees what THEY initiated (falling back to
        // "cashier of record" only for pre-ticket-workflow sales that
        // have no attendant on them at all).
        if (hasRole(userRole, 'manager')) {
          // no filter
        } else if (userRole === 'cashier') {
          query = query.eq('cashier_id', session.user.id);
        } else {
          query = query.or(
            `attendant_id.eq.${session.user.id},and(attendant_id.is.null,cashier_id.eq.${session.user.id})`
          );
        }

        const { data: pageData, error } = await query;

        if (error) throw error;
        if (!pageData || pageData.length === 0) break;

        allSales = allSales.concat(pageData);

        if (pageData.length < SALES_FETCH_PAGE_SIZE) break;
        from += SALES_FETCH_PAGE_SIZE;
        page += 1;
      }

      if (allSales.length > 0) {
        const formatted = allSales.map((s) => ({
          id: s.id,
          total: Number(s.total || s.total_amount || 0),
          saleType: s.sale_type || s.saleType || 'retail',
          cashierId: s.cashier_id || s.cashierId,
          cashierEmail: s.cashier_email || s.cashierEmail,
          attendantId: s.attendant_id || s.attendantId || null,
          attendantEmail: s.attendant_email || s.attendantEmail || null,
          customerName:
            s.customer_name || s.customerName || 'Walk-in Customer',
          customerPhone: s.customer_phone || s.customerPhone || 'N/A',
          customerId: s.customer_id || s.customerId || null,
          amountPaid: s.amount_paid ?? s.amountPaid ?? null,
          customerBalanceBefore: s.customer_balance_before ?? s.customerBalanceBefore ?? null,
          customerBalanceAfter: s.customer_balance_after ?? s.customerBalanceAfter ?? null,
          createdAt: s.created_at || s.createdAt,
          items:
            typeof s.items === 'string'
              ? JSON.parse(s.items)
              : s.items || [],
          synced: 1
        }));

        setCloudSales(formatted);
      }
    } catch (err) {
      console.warn('Cloud sales fetch deferred:', err.message);
    }
  };

  // ============================================================
  // ONLINE / OFFLINE SYNC
  // ============================================================
  useEffect(() => {
    const runAllSync = () => {
      syncPendingDrugsToCloud().then(() => {
        syncDrugsFromCloud();
      });

      syncPendingSalesToCloud().then(() => {
        fetchCloudSales();
      });

      syncPendingReversalsToCloud();

      syncPendingReversalRequestsToCloud().then(() => {
        fetchCloudReversalRequests();
      });

      syncAuditLogToCloud();
      fetchCloudAuditLog();

      syncPendingTicketsToCloud().then(() => {
        fetchCloudTickets();
      });

      syncPendingBankOptionsToCloud().then(() => {
        fetchBankOptions();
      });

      syncPendingSuppliersToCloud().then(() => {
        fetchSuppliers();
      });

      syncPendingStockEntriesToCloud().then(() => {
        fetchCloudStockEntries();
      });

      syncPendingStockEntryEditsToCloud().then(() => {
        fetchCloudStockEntryEdits();
      });

      syncPendingSupplierChangeRequestsToCloud().then(() => {
        fetchCloudSupplierChangeRequests();
      });

      syncPendingDrugChangeRequestsToCloud().then(() => {
        fetchCloudDrugChangeRequests();
      });

      syncPendingPurchasePlansToCloud().then(() => {
        fetchCloudPurchasePlans();
      });

      syncPendingCustomersToCloud().then(() => {
        fetchCustomers();
      });

      syncPendingCustomerChangeRequestsToCloud().then(() => {
        fetchCloudCustomerChangeRequests();
      });

      expireStaleTickets();

      pruneSalesOlderThanOneYear();

      // One-time-safe cleanup: anything already sitting at a negative
      // stock count (from before the floor-at-0 clamp existed on every
      // write path) gets floored to 0 and pushed to the cloud, so old
      // data converges with the new rule instead of staying negative
      // forever.
      clampNegativeStockToZero();
    };

    runAllSyncRef.current = runAllSync;

    const handleOnline = () => {
      // The browser's own "online" event only means a network adapter
      // came up — it doesn't mean the internet (or Supabase) is actually
      // reachable. Confirm with a real request before flipping the badge
      // and kicking off a sync that would just fail anyway.
      checkRealConnectivity().then((reallyOnline) => {
        setIsOnline(reallyOnline);
        if (reallyOnline) runAllSync();
      });
    };

    const handleOffline = () => {
      // No network adapter at all — this one IS reliable, no need to
      // double-check it.
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    if (navigator.onLine) {
      runAllSync();
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [session, userRole]);

  // ============================================================
  // REAL CONNECTIVITY CHECK
  // ------------------------------------------------------------
  // navigator.onLine (and the browser's online/offline events) only
  // reflect whether the device has a network interface up — connected
  // to Wi-Fi with no actual internet behind it still reads "online".
  // This instead tries an actual, tiny Supabase request so the "Online"
  // / "Offline" badge reflects whether the app can really reach the
  // server, not just whether a cable is plugged in. A single blip
  // doesn't flip the badge — two consecutive failed checks are needed
  // before it switches to "Offline", so one slow response doesn't make
  // it flicker; any single success switches it right back to "Online".
  // ============================================================
  const connectivityFailureCountRef = useRef(0);

  async function checkRealConnectivity() {
    if (!navigator.onLine) return false;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 6000);
      const { error } = await supabase
        .from('app_settings')
        .select('key')
        .limit(1)
        .abortSignal(controller.signal);
      clearTimeout(timeout);
      if (error) throw error;
      connectivityFailureCountRef.current = 0;
      return true;
    } catch {
      connectivityFailureCountRef.current += 1;
      return connectivityFailureCountRef.current < 2;
    }
  }

  useEffect(() => {
    if (!session) return;
    const interval = setInterval(async () => {
      const reallyOnline = await checkRealConnectivity();
      setIsOnline((prev) => {
        if (reallyOnline !== prev && reallyOnline) {
          // Coming back from a real outage (not just a flipped badge) —
          // catch up on anything that piled up while unreachable.
          setTimeout(() => runAllSyncRef.current?.(), 0);
        }
        return reallyOnline;
      });
    }, 30000);
    return () => clearInterval(interval);
  }, [session]);

  // A pure cashier account has no POS tab (see the nav above) — if their
  // role loads in after the default 'pos' tab is already selected (or
  // they were switched to cashier while the app was open), bounce them
  // straight to their Queue instead of showing an empty/inaccessible tab.
  useEffect(() => {
    if (userRole === 'cashier' && activeTab === 'pos') {
      setActiveTab('tickets');
    }
  }, [userRole, activeTab]);

  // An administrator account is oversight-only — it never sells, builds
  // tickets or approves payment, so the only tab that exists for it is
  // Admin. Bounce straight there, same pattern as the cashier redirect
  // above, whether that's the default tab on first login or a role
  // change happened mid-session.
  useEffect(() => {
    if (userRole === 'administrator' && activeTab !== 'admin') {
      setActiveTab('admin');
    }
  }, [userRole, activeTab]);

  // Load the admin-saved pricing-recommendation percentages once a
  // session exists — everyone needs this (it drives the price hint
  // shown to anyone entering a cost price), not just the admin editing
  // it, so this isn't gated on activeTab/adminSection.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    fetchPricingSettings().then((settings) => {
      if (cancelled) return;
      setPricingSettings(settings);
      setPricingSettingsForm(settings);
    });
    return () => {
      cancelled = true;
    };
  }, [session]);

  useEffect(() => {
    if (activeTab === 'history' && isOnline) {
      fetchCloudSales();
    }
  }, [activeTab, isOnline]);

  // ============================================================
  // ALWAYS-ON LIVE TICKET SYNC
  // ------------------------------------------------------------
  // Runs on EVERY page (restocking, history, admin — anywhere) for any
  // signed-in terminal, not just the POS/Queue tabs:
  //   * a Supabase Realtime subscription pushes a ticket/stock change
  //     the instant it happens on any other terminal, and
  //   * a lightweight refresh every 5 seconds is the safety net for
  //     anything Realtime misses (dropped websocket, sleeping tablet),
  //     plus a refresh the moment the tab/app regains focus or the
  //     network comes back.
  // The refresh is small on purpose (open tickets + the last 2 hours),
  // so running it constantly stays well inside the free-tier egress.
  // ============================================================
  const [realtimeStatus, setRealtimeStatus] = useState('connecting');

  useEffect(() => {
    if (!session || !isOnline) return undefined;

    let stopped = false;
    let running = false;

    const refreshNow = async () => {
      if (stopped || running) return;
      running = true;
      try {
        await fetchLiveTickets();
        await expireStaleTickets();
      } finally {
        running = false;
      }
    };

    refreshNow();
    const interval = setInterval(refreshNow, 5000);

    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshNow();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refreshNow);

    const channel = supabase
      .channel(`live-sync-${session.user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tickets' },
        (payload) => {
          if (payload.new && payload.new.id) applyRealtimeTicketRow(payload.new);
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'drugs' },
        (payload) => {
          if (payload.new && payload.new.id !== undefined) {
            applyRealtimeDrugRow(payload.new);
          }
        }
      )
      .subscribe((status) => {
        if (stopped) return;
        setRealtimeStatus(status === 'SUBSCRIBED' ? 'live' : 'polling');
      });

    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refreshNow);
      supabase.removeChannel(channel);
    };
  }, [session?.user?.id, isOnline]);

  // Keep the name directory fresh (and sign out an account an
  // administrator has just deactivated — its existing login token would
  // otherwise keep working until it expires).
  useEffect(() => {
    if (!session || !isOnline) return undefined;
    let stopped = false;

    const refreshDirectory = async () => {
      const rows = await fetchProfileDirectory();
      if (stopped || !rows) return;
      setProfileDirectory(rows);
      const me = rows.find((p) => p.id === session.user.id);
      if (me && me.is_active === false) {
        alert('This account has been deactivated. Please contact an administrator.');
        await supabase.auth.signOut();
        setCart([]);
        setSession(null);
      }
    };

    refreshDirectory();
    const interval = setInterval(refreshDirectory, 60000);
    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [session?.user?.id, isOnline]);

  // ============================================================
  // DRUG INVENTORY (soft-deleted drugs are hidden from the catalog)
  // ============================================================
  const drugs = useLiveQuery(async () => {
    const all = !searchTerm.trim()
      ? await db.drugs.toArray()
      : await db.drugs
          .filter((drug) => {
            const term = searchTerm.toLowerCase().trim();
            const nameMatch = drug.name?.toLowerCase().includes(term);
            const barcodeMatch = drug.barcode?.toLowerCase().includes(term);
            const counterMatch = drug.counterSpace?.toLowerCase().includes(term);
            return Boolean(nameMatch || barcodeMatch || counterMatch);
          })
          .toArray();

    return all.filter((drug) => !drug.deletedAt);
  }, [searchTerm]);

  // Full active-drug list for the Drugs & Suppliers hub's own Drugs
  // sub-tab — independent of the ticket-builder's searchTerm above, so
  // typing in one search box doesn't affect the other screen.
  const allActiveDrugsForCrud = useLiveQuery(async () => {
    const all = await db.drugs.toArray();
    return all.filter((d) => !d.deletedAt).sort((a, b) => a.name.localeCompare(b.name));
  }, []);

  const drugCrudMatches = React.useMemo(() => {
    if (!allActiveDrugsForCrud) return [];
    const term = drugCrudSearchTerm.toLowerCase().trim();
    if (!term) return allActiveDrugsForCrud;
    return allActiveDrugsForCrud.filter(
      (d) =>
        d.name?.toLowerCase().includes(term) ||
        d.barcode?.toLowerCase().includes(term) ||
        d.counterSpace?.toLowerCase().includes(term)
    );
  }, [allActiveDrugsForCrud, drugCrudSearchTerm]);

  // ============================================================
  // RECENTLY DELETED DRUGS (administrator only)
  // ============================================================
  const deletedDrugs = useLiveQuery(async () => {
    if (!hasRole(userRole, 'administrator')) return [];
    const all = await db.drugs.toArray();
    return all
      .filter((drug) => drug.deletedAt)
      .sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
  }, [userRole]);

  // ============================================================
  // AUDIT LOG (administrator only)
  // ============================================================
  const auditLog = useLiveQuery(async () => {
    if (!hasRole(userRole, 'administrator')) return [];
    return db.auditLog.orderBy('createdAt').reverse().toArray();
  }, [userRole]);

  // Every distinct action type actually present in the log, so the
  // filter buttons only ever show options that exist (no "Drug Added"
  // button sitting there uselessly if nobody has added a drug yet).
  const auditActionTypes = React.useMemo(() => {
    if (!auditLog) return [];
    return Array.from(new Set(auditLog.map((e) => e.action))).sort();
  }, [auditLog]);

  const filteredAuditLog = React.useMemo(() => {
    if (!auditLog) return [];
    if (auditActionFilter === 'all') return auditLog;
    return auditLog.filter((e) => e.action === auditActionFilter);
  }, [auditLog, auditActionFilter]);

  const unseenManagerChanges = React.useMemo(() => {
    if (!auditLog) return 0;
    const managerEntries = auditLog.filter((entry) => entry.actorRole === 'manager');
    if (!lastSeenAuditAt) return managerEntries.length;
    return managerEntries.filter(
      (entry) => new Date(entry.createdAt) > new Date(lastSeenAuditAt)
    ).length;
  }, [auditLog, lastSeenAuditAt]);

  const handleOpenAdminTab = () => {
    setActiveTab('admin');
    const now = new Date().toISOString();
    localStorage.setItem(LAST_SEEN_AUDIT_KEY, now);
    setLastSeenAuditAt(now);

    // Pull in any audit entries other admins/managers made on other
    // devices right away, instead of waiting for the next reconnect —
    // same freshness-on-open pattern as Sales History.
    if (navigator.onLine) {
      fetchCloudAuditLog();
    }
  };

  // ============================================================
  // TICKETS (fetchCloudTickets merges cloud data straight into local
  // Dexie, so this one query already reflects every device's tickets)
  // ============================================================
  const allTickets = useLiveQuery(async () => {
    const all = await db.tickets.orderBy('createdAt').reverse().toArray();

    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    return all.filter((t) => new Date(t.createdAt) >= twoDaysAgo);
  }, []);

  // Tickets that exist only on THIS device after more than a few seconds
  // — the cashier can't see them yet. Surfaced as a banner so a failed
  // upload is never silent.
  const undeliveredTickets = useLiveQuery(async () => {
    const rows = await db.tickets.where('synced').equals(0).toArray();
    return rows.filter((t) => t.status === 'PENDING_PAYMENT');
  }, []);

  // What the CASHIER queue shows: every attendant's submitted tickets
  // still awaiting payment, oldest first so nobody waits out of turn.
  const pendingTickets = React.useMemo(() => {
    if (!allTickets) return [];
    return allTickets
      .filter((t) => t.status === 'PENDING_PAYMENT')
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }, [allTickets]);

  // Ticket-payment approval is a cashier's job, or a manager stepping in
  // for accountability reasons — deliberately NOT administrator, even
  // though admin outranks both of them everywhere else in the app.
  const canApproveTickets = userRole === 'cashier' || userRole === 'manager';

  // ============================================================
  // RESTOCK FROM SUPPLIER — data
  // ============================================================
  const suppliers = useLiveQuery(() => db.suppliers.toArray(), []);

  // Active suppliers for pickers/lists; soft-deleted ones only surface
  // in Admin → Recently Deleted, same split as drugs.
  const activeSuppliers = React.useMemo(
    () => (suppliers || []).filter((s) => !s.deletedAt),
    [suppliers]
  );
  const deletedSuppliers = React.useMemo(
    () => (suppliers || []).filter((s) => !!s.deletedAt),
    [suppliers]
  );

  const allSupplierChangeRequests = useLiveQuery(
    () => db.supplierChangeRequests.orderBy('createdAt').reverse().toArray(),
    []
  );
  const pendingSupplierChangeRequests = React.useMemo(() => {
    if (!allSupplierChangeRequests) return [];
    return allSupplierChangeRequests.filter((r) => r.status === 'PENDING');
  }, [allSupplierChangeRequests]);

  // Wholesale customers — same active/deleted split as suppliers.
  const customers = useLiveQuery(() => db.customers.toArray(), []);
  const activeCustomers = React.useMemo(
    () => (customers || []).filter((c) => !c.deletedAt),
    [customers]
  );
  const deletedCustomers = React.useMemo(
    () => (customers || []).filter((c) => !!c.deletedAt),
    [customers]
  );
  const customersById = React.useMemo(() => {
    const map = new Map();
    (customers || []).forEach((c) => map.set(String(c.id), c));
    return map;
  }, [customers]);

  const allCustomerChangeRequests = useLiveQuery(
    () => db.customerChangeRequests.orderBy('createdAt').reverse().toArray(),
    []
  );
  const pendingCustomerChangeRequests = React.useMemo(() => {
    if (!allCustomerChangeRequests) return [];
    return allCustomerChangeRequests.filter((r) => r.status === 'PENDING');
  }, [allCustomerChangeRequests]);

  // Same shape, for a cashier's drug edit/delete requests.
  const allDrugChangeRequests = useLiveQuery(
    () => db.drugChangeRequests.orderBy('createdAt').reverse().toArray(),
    []
  );
  const pendingDrugChangeRequests = React.useMemo(() => {
    if (!allDrugChangeRequests) return [];
    return allDrugChangeRequests.filter((r) => r.status === 'PENDING');
  }, [allDrugChangeRequests]);

  // One row per drug, live — see the schema v13 comment in db.js for
  // why this replaced the old generate/save/reopen purchase lists.
  const purchasePlans = useLiveQuery(() => db.purchasePlans.toArray(), []);
  const purchasePlanByDrugId = React.useMemo(() => {
    const map = new Map();
    (purchasePlans || []).forEach((p) => map.set(String(p.drugId), p));
    return map;
  }, [purchasePlans]);

  const allStockEntries = useLiveQuery(
    () => db.stockEntries.orderBy('createdAt').reverse().toArray(),
    []
  );

  // The supplier most recently delivered each drug from an APPLIED
  // stock entry — the live default shown on the purchase list whenever
  // a drug's plan has no manual supplier override.
  const lastSupplierByDrugId = React.useMemo(() => {
    const map = new Map();
    (allStockEntries || [])
      .filter((e) => e.status === 'APPLIED' && e.supplierId)
      .forEach((entry) => {
        (entry.items || []).forEach((item) => {
          if (!item.drugId) return;
          const key = String(item.drugId);
          const existing = map.get(key);
          if (!existing || new Date(entry.createdAt) > new Date(existing.lastSeenAt)) {
            map.set(key, {
              supplierId: entry.supplierId,
              supplierName: entry.supplierName,
              lastSeenAt: entry.createdAt
            });
          }
        });
      });
    return map;
  }, [allStockEntries]);

  // Everything currently finished or below its minimum, minus whatever
  // has been pushed to "Not to Buy" — enriched with each drug's plan
  // (or sensible defaults when it doesn't have one yet). This is THE
  // purchase list: always live, never a stale snapshot. A drug drops
  // off the instant its stock is restored, and reappears — with
  // whatever quantity/supplier was last set for it — the moment it
  // finishes again.
  const purchaseNeedsList = React.useMemo(() => {
    return (drugs || [])
      .filter((d) => {
        const stock = Number(d.stock || 0);
        const min = d.minStockQty != null ? Number(d.minStockQty) : null;
        const needsRestock = stock <= 0 || (min !== null && stock < min);
        if (!needsRestock) return false;
        const plan = purchasePlanByDrugId.get(String(d.id));
        return !plan?.excluded;
      })
      .map((d) => {
        const plan = purchasePlanByDrugId.get(String(d.id));
        const lastSupplier = lastSupplierByDrugId.get(String(d.id));
        const min = d.minStockQty != null ? Number(d.minStockQty) : null;
        const fallbackQty =
          d.recommendedPurchaseQty ??
          (min !== null ? Math.max(min * 2 - Number(d.stock || 0), min) : 10);
        const usingManualSupplier = Boolean(plan?.supplierManual && plan?.supplierId);
        return {
          drugId: d.id,
          drugName: d.name,
          unitType: d.unitType,
          currentStock: Number(d.stock || 0),
          minStockQty: min,
          quantity: plan?.quantity ?? Math.max(1, Math.round(Number(fallbackQty) || 10)),
          unitCost: plan?.unitCost ?? Number(d.costPrice || 0),
          supplierId: usingManualSupplier ? plan.supplierId : lastSupplier?.supplierId || null,
          supplierName: usingManualSupplier
            ? plan.supplierName
            : lastSupplier?.supplierName || null,
          supplierIsManual: usingManualSupplier
        };
      })
      .sort((a, b) => a.drugName.localeCompare(b.drugName));
  }, [drugs, purchasePlanByDrugId, lastSupplierByDrugId]);

  const filteredPurchaseNeedsList = React.useMemo(() => {
    const term = purchasePlanSearchTerm.trim().toLowerCase();
    if (!term) return purchaseNeedsList;
    return purchaseNeedsList.filter((item) =>
      item.drugName.toLowerCase().includes(term)
    );
  }, [purchaseNeedsList, purchasePlanSearchTerm]);

  // Drugs deliberately set aside — shown regardless of current stock
  // level, since the point is "don't show me this until I say so".
  const notToBuyList = React.useMemo(() => {
    const excludedIds = new Set(
      (purchasePlans || []).filter((p) => p.excluded).map((p) => String(p.drugId))
    );
    if (excludedIds.size === 0) return [];
    return (drugs || [])
      .filter((d) => excludedIds.has(String(d.id)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [drugs, purchasePlans]);

  // Grouped by supplier for printing/export — "Unspecified Supplier"
  // catches anything with no known or chosen supplier at all.
  const purchaseListGroupedBySupplier = React.useCallback((items) => {
    const groups = new Map();
    items.forEach((item) => {
      const key = item.supplierId || '__unspecified__';
      const label = item.supplierName || 'Unspecified Supplier';
      if (!groups.has(key)) groups.set(key, { supplierName: label, items: [] });
      groups.get(key).items.push(item);
    });
    return Array.from(groups.values()).sort((a, b) =>
      a.supplierName.localeCompare(b.supplierName)
    );
  }, []);

  // Only cashiers and managers touch this feature at all — a manager's
  // own entry is applied the moment they submit it; a cashier's sits
  // PENDING until a manager approves it.
  const canUseRestock = userRole === 'cashier' || userRole === 'manager';
  const canApproveStockEntries = userRole === 'manager';

  const pendingStockEntries = React.useMemo(() => {
    if (!allStockEntries) return [];
    return allStockEntries.filter((e) => e.status === 'PENDING');
  }, [allStockEntries]);

  // What the person who entered it sees: their own stock entries of any
  // status, so a cashier can tell whether theirs went through yet.
  const myStockEntries = React.useMemo(() => {
    if (!allStockEntries || !session) return [];
    return allStockEntries.filter(
      (e) => isMyEmail(e.enteredByEmail)
    );
  }, [allStockEntries, session]);

  // A stock entry (any status) is still correctable if it's within the
  // edit window and the viewer is either the one who entered it or a
  // manager/administrator — mirrors editStockEntry's own rule in db.js.
  const isStockEntryEditable = (entry) => {
    if (!entry || entry.status === 'REJECTED') return false;
    const ageMs = Date.now() - new Date(entry.createdAt).getTime();
    if (ageMs > STOCK_ENTRY_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000) return false;
    const isOwner = isMyEmail(entry.enteredByEmail);
    return isOwner || hasRole(userRole, 'manager');
  };

  // Pending edit requests (a cashier correcting their own already-
  // submitted entry) — same cashier-needs-approval shape as the entries
  // themselves.
  const allStockEntryEdits = useLiveQuery(
    () => db.stockEntryEdits.orderBy('createdAt').reverse().toArray(),
    []
  );

  const pendingStockEntryEdits = React.useMemo(() => {
    if (!allStockEntryEdits) return [];
    return allStockEntryEdits.filter((e) => e.status === 'PENDING');
  }, [allStockEntryEdits]);

  // A quick lookup from stockEntryId -> its own still-pending edit
  // request (if any), so a stock-entry row can show "edit awaiting
  // approval" instead of offering another Edit button on top of it.
  const pendingEditByStockEntryId = React.useMemo(() => {
    const map = new Map();
    pendingStockEntryEdits.forEach((e) => map.set(String(e.stockEntryId), e));
    return map;
  }, [pendingStockEntryEdits]);

  // Same idea for a drug/supplier already sitting in a pending change
  // request — a row shows "awaiting approval" instead of another
  // Edit/Delete button stacking on top of it.
  const pendingDrugChangeByDrugId = React.useMemo(() => {
    const map = new Map();
    pendingDrugChangeRequests.forEach((r) => map.set(String(r.drugId), r));
    return map;
  }, [pendingDrugChangeRequests]);

  const pendingSupplierChangeBySupplierId = React.useMemo(() => {
    const map = new Map();
    pendingSupplierChangeRequests.forEach((r) => map.set(String(r.supplierId), r));
    return map;
  }, [pendingSupplierChangeRequests]);

  // ============================================================
  // REVERSAL REQUESTS (cashier-initiated reversal, pending manager sign-off)
  // ============================================================
  const allReversalRequests = useLiveQuery(
    () => db.reversalRequests.orderBy('createdAt').reverse().toArray(),
    []
  );

  const pendingReversalRequests = React.useMemo(() => {
    if (!allReversalRequests) return [];
    return allReversalRequests.filter((r) => r.status === 'PENDING');
  }, [allReversalRequests]);

  // ============================================================
  // CASHIER CHIME — a short two-note tone whenever a NEW ticket lands
  // in the Queue, so a cashier doesn't have to keep staring at the
  // screen to notice a customer is ready to pay. Built with the Web
  // Audio API (no audio file to fetch/cache), so it works offline too.
  // Only wired up for cashier-rank accounts, and never fires on the
  // very first load of an already-full queue — only on an increase
  // after that.
  // ============================================================
  const prevPendingCountRef = useRef(null);

  const playQueueChime = () => {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;

      const playTone = (freq, startTime, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, startTime);
        gain.gain.exponentialRampToValueAtTime(0.3, startTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(startTime);
        osc.stop(startTime + duration + 0.05);
      };

      playTone(880, now, 0.15);
      playTone(1175, now + 0.15, 0.22);
    } catch (err) {
      console.warn('Unable to play queue chime:', err.message);
    }
  };

  useEffect(() => {
    if (!canApproveTickets) return;

    const count = pendingTickets.length;

    if (prevPendingCountRef.current === null) {
      // First measurement after login/reload — don't chime for tickets
      // that were already sitting in the queue before this device
      // opened it.
      prevPendingCountRef.current = count;
      return;
    }

    if (count > prevPendingCountRef.current) {
      playQueueChime();
    }

    prevPendingCountRef.current = count;
  }, [pendingTickets, userRole]);

  // What the ATTENDANT sees: their own submitted tickets (any status),
  // so they can see a ticket go PAID or follow up on one that's
  // lingered in PENDING_PAYMENT too long.
  const myRecentTickets = React.useMemo(() => {
    if (!allTickets || !session) return [];
    return allTickets.filter(
      (t) =>
        t.attendantId === session.user.id ||
        isMyEmail(t.attendantEmail)
    );
  }, [allTickets, session]);

  // Tickets the cashier sent back to ME for adjustment, still waiting
  // to be reopened and resubmitted.
  const mySentBackTickets = React.useMemo(
    () => myRecentTickets.filter((t) => t.status === 'SENT_BACK'),
    [myRecentTickets]
  );

  const bankOptions = useLiveQuery(async () => {
    const all = await db.bankOptions.toArray();
    return all.filter((b) => b.active !== false);
  }, []);

  // ============================================================
  // LOCAL SALES
  // ============================================================
  const localSales = useLiveQuery(async () => {
    if (!session) return [];

    let records = await db.sales.orderBy('createdAt').reverse().toArray();

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    records = records.filter(
      (s) => new Date(s.createdAt) >= oneYearAgo
    );

    // Manager and administrator see every sale — both the ones they
    // personally closed and the ones everyone else closed. A cashier
    // sees only the sales THEY closed (approved payment on). A
    // salesperson sees only the sales THEY initiated (built the
    // ticket for) — or, for an old-style sale that has no attendant on
    // record at all, one they're the cashier of record for, so sales
    // from before the ticket workflow existed don't just disappear.
    if (hasRole(userRole, 'manager')) {
      // no filter — everything
    } else if (userRole === 'cashier') {
      records = records.filter(
        (s) =>
          s.cashierId === session.user.id ||
          isMyEmail(s.cashierEmail)
      );
    } else {
      records = records.filter(
        (s) =>
          s.attendantId === session.user.id ||
          isMyEmail(s.attendantEmail) ||
          (!s.attendantId &&
            !s.attendantEmail &&
            (s.cashierId === session.user.id ||
              isMyEmail(s.cashierEmail)))
      );
    }

    return records;
  }, [session, userRole]);

  // ============================================================
  // MERGE SALES
  // ============================================================
  const salesHistory = React.useMemo(() => {
    const combinedMap = new Map();

    cloudSales.forEach((s) => {
      combinedMap.set(String(s.id), s);
    });

    (localSales || []).forEach((s) => {
      combinedMap.set(String(s.id), s);
    });

    let records = Array.from(combinedMap.values());

    records.sort(
      (a, b) =>
        new Date(b.createdAt) - new Date(a.createdAt)
    );

    if (
      hasRole(userRole, 'manager') &&
      historyCashierFilter !== 'all'
    ) {
      records = records.filter(
        (s) => s.cashierEmail === historyCashierFilter
      );
    }

    if (historySearchTerm.trim()) {
      const term = historySearchTerm.toLowerCase();

      records = records.filter(
        (s) =>
          (s.customerName &&
            s.customerName.toLowerCase().includes(term)) ||
          (s.customerPhone &&
            s.customerPhone.includes(term)) ||
          (s.id &&
            String(s.id).toLowerCase().includes(term))
      );
    }

    return records;
  }, [
    localSales,
    cloudSales,
    userRole,
    historyCashierFilter,
    historySearchTerm
  ]);

  // All sales (local + cloud, deduped, 1-year window), unaffected by
  // whatever filters are currently set on the Sales History tab — this
  // is what the Admin drug-accountability search runs against.
  const allSalesForSearch = React.useMemo(() => {
    const combinedMap = new Map();

    cloudSales.forEach((s) => combinedMap.set(String(s.id), s));
    (localSales || []).forEach((s) => combinedMap.set(String(s.id), s));

    return Array.from(combinedMap.values()).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
  }, [localSales, cloudSales]);

  // ============================================================
  // ADMIN: FINANCIAL DASHBOARD
  // Total stock value, amount owed to suppliers, today's sales/profit,
  // and profit over any admin-chosen date range — all computed live
  // from data already loaded elsewhere (drugs, stock entries, sales),
  // nothing extra fetched or stored for this.
  // ============================================================

  // What every drug currently sitting in stock is worth, at cost.
  const dashboardStockValue = React.useMemo(() => {
    return (allActiveDrugsForCrud || []).reduce(
      (sum, d) => sum + Number(d.stock || 0) * Number(d.costPrice || 0),
      0
    );
  }, [allActiveDrugsForCrud]);

  // What's still owed across every APPLIED stock entry — i.e. stock
  // that's already in the pharmacy but hasn't been fully paid for yet.
  const dashboardOwedToSuppliers = React.useMemo(() => {
    return (allStockEntries || [])
      .filter((e) => e.status === 'APPLIED')
      .reduce((sum, e) => {
        const owed = Number(e.totalCost || 0) - Number(e.amountPaid || 0);
        return sum + (owed > 0 ? owed : 0);
      }, 0);
  }, [allStockEntries]);

  // Quick drugId -> drug lookup, for sale line items old enough that
  // they predate the costPrice snapshot on the item itself.
  const dashboardDrugLookup = React.useMemo(() => {
    const map = new Map();
    (allActiveDrugsForCrud || []).forEach((d) => map.set(String(d.id), d));
    return map;
  }, [allActiveDrugsForCrud]);

  // Profit on one sale: revenue minus what each line item actually
  // cost. Prefers the costPrice snapshotted on the item at sale time;
  // falls back to the drug's current cost price for older sales/items
  // that predate that snapshot, and treats it as 0 cost (counts the
  // full line as profit) only if the drug can no longer be found at
  // all — better than silently dropping the sale from the figures.
  const computeSaleProfit = React.useCallback(
    (sale) => {
      return (sale.items || []).reduce((sum, item) => {
        const qty = Number(item.quantity || 0);
        const lineTotal = Number(item.lineTotal || 0);
        let costPrice = Number(item.costPrice || 0);
        if (!costPrice) {
          const drug = dashboardDrugLookup.get(String(item.id));
          costPrice = Number(drug?.costPrice || 0);
        }
        return sum + (lineTotal - costPrice * qty);
      }, 0);
    },
    [dashboardDrugLookup]
  );

  const dashboardTodaySales = React.useMemo(() => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return (allSalesForSearch || []).filter(
      (s) => new Date(s.createdAt) >= startOfDay
    );
  }, [allSalesForSearch]);

  const dashboardTodayTotals = React.useMemo(() => {
    return dashboardTodaySales.reduce(
      (acc, sale) => {
        acc.revenue += Number(sale.total || 0);
        acc.profit += computeSaleProfit(sale);
        return acc;
      },
      { revenue: 0, profit: 0 }
    );
  }, [dashboardTodaySales, computeSaleProfit]);

  // Profit over whatever date range the admin picks — blank until
  // both ends are chosen.
  const dashboardRangeTotals = React.useMemo(() => {
    if (!dashboardRangeStart || !dashboardRangeEnd) return null;
    const rangeStart = new Date(`${dashboardRangeStart}T00:00:00.000`);
    const rangeEnd = new Date(`${dashboardRangeEnd}T23:59:59.999`);
    const inRange = (allSalesForSearch || []).filter((s) => {
      const t = new Date(s.createdAt);
      return t >= rangeStart && t <= rangeEnd;
    });
    return inRange.reduce(
      (acc, sale) => {
        acc.revenue += Number(sale.total || 0);
        acc.profit += computeSaleProfit(sale);
        acc.count += 1;
        return acc;
      },
      { revenue: 0, profit: 0, count: 0 }
    );
  }, [allSalesForSearch, dashboardRangeStart, dashboardRangeEnd, computeSaleProfit]);

  // ============================================================
  // ADMIN: DRUG SALE ACCOUNTABILITY SEARCH
  // Finds every line item across every sale matching the searched drug
  // name, with which salesperson/manager account sold it and when — for
  // tracing expensive drugs back to who sold them.
  // ============================================================
  const drugSaleMatches = React.useMemo(() => {
    const term = drugSearchTerm.trim().toLowerCase();
    if (!term) return [];

    const matches = [];

    allSalesForSearch.forEach((sale) => {
      (sale.items || []).forEach((item) => {
        if (item.name && item.name.toLowerCase().includes(term)) {
          matches.push({
            saleId: sale.id,
            drugName: item.name,
            unitType: item.unitType || item.unit_type || '',
            quantity: item.quantity,
            reversedQty: Number(item.reversedQty) || 0,
            lineTotal:
              item.lineTotal ?? (item.activePrice || 0) * item.quantity,
            cashierEmail: sale.cashierEmail,
            customerName: sale.customerName,
            createdAt: sale.createdAt
          });
        }
      });
    });

    return matches;
  }, [drugSearchTerm, allSalesForSearch]);

  // ============================================================
  // PARTIAL SALE REVERSAL
  // reversalQtys is keyed by item id → how many units of that line to
  // reverse (never more than quantity minus whatever was already
  // reversed earlier). A manager/administrator's reversal takes effect
  // immediately (reverseSaleItems). A cashier doesn't have the
  // authority to reverse their own approval unchecked, so theirs only
  // files a REQUEST — nothing about the sale changes until a manager
  // approves it from their own account (see Pending Reversal Requests
  // in Sales History).
  // ============================================================
  const handleConfirmReversal = async () => {
    if (!reversingSale) return;

    const reversals = Object.entries(reversalQtys)
      .map(([id, qty]) => ({ id, quantity: Number(qty) || 0 }))
      .filter((r) => r.quantity > 0);

    if (reversals.length === 0) {
      alert('Enter a quantity to reverse for at least one item.');
      return;
    }

    setIsReversing(true);

    try {
      if (hasRole(userRole, 'manager')) {
        const result = await reverseSaleItems(reversingSale, reversals, {
          email: session?.user?.email,
          role: userRole
        });

        if (result.success) {
          // Keep cloudSales in sync too, in case this sale only exists
          // in the cloud (made on a different device) — localSales
          // already updates itself via useLiveQuery.
          setCloudSales((prev) =>
            prev.map((s) =>
              String(s.id) === String(reversingSale.id)
                ? {
                    ...s,
                    items: result.updatedItems,
                    total: result.newTotal,
                    reversalLog: result.reversalLog
                  }
                : s
            )
          );

          if (result.customerBalanceAdjustment > 0) {
            alert(
              `Reversed. ${reversingSale.customerName || 'The customer'}'s account was reduced by ₦${Number(result.customerBalanceAdjustment).toLocaleString()}` +
                (result.customerBalanceNow !== null && result.customerBalanceNow !== undefined
                  ? ` — balance is now ${
                      result.customerBalanceNow >= 0
                        ? `₦${Number(result.customerBalanceNow).toLocaleString()} owed by the customer`
                        : `₦${Math.abs(Number(result.customerBalanceNow)).toLocaleString()} credit owed to the customer`
                    }.`
                  : '.')
            );
          }
          setReversingSale(null);
          setReversalQtys({});
        } else {
          alert(result.reason || 'Unable to reverse those items.');
        }
      } else {
        const result = await requestSaleReversal(reversingSale, reversals, {
          id: session?.user?.id,
          email: session?.user?.email,
          role: userRole
        });

        if (result.success) {
          alert(
            'Reversal request sent. Nothing changes on this sale until a manager approves it.'
          );
          setReversingSale(null);
          setReversalQtys({});
        } else {
          alert(result.reason || 'Unable to submit that reversal request.');
        }
      }
    } finally {
      setIsReversing(false);
    }
  };

  // ============================================================
  // MANAGER: APPROVE / REJECT A CASHIER'S REVERSAL REQUEST
  // ============================================================
  const handleApproveReversalRequest = async (request) => {
    const sale =
      salesHistory.find((s) => String(s.id) === String(request.saleId)) ||
      allSalesForSearch.find((s) => String(s.id) === String(request.saleId));

    if (!sale) {
      alert('Could not find the underlying sale for this request.');
      return;
    }

    const result = await approveReversalRequest(request, sale, {
      id: session?.user?.id,
      email: session?.user?.email,
      role: userRole
    });

    if (result.success) {
      setCloudSales((prev) =>
        prev.map((s) =>
          String(s.id) === String(request.saleId)
            ? {
                ...s,
                items: result.updatedItems,
                total: result.newTotal,
                reversalLog: result.reversalLog
              }
            : s
        )
      );
      if (result.customerBalanceAdjustment > 0) {
        alert(
          `Reversal approved. The wholesale customer's account was reduced by ₦${Number(result.customerBalanceAdjustment).toLocaleString()}.`
        );
      }
    } else {
      alert(result.reason || 'Unable to approve this reversal request.');
    }
  };

  const handleRejectReversalRequest = async (request) => {
    if (!window.confirm('Reject this reversal request? The sale stays as-is.')) {
      return;
    }

    await rejectReversalRequest(request, {
      id: session?.user?.id,
      email: session?.user?.email,
      role: userRole
    });
  };

  // ============================================================
  // CART OPERATIONS
  // ============================================================
  const addToCart = (drug) => {
    const retail = Number(
      drug.retailPrice ?? drug.retail_price ?? 0
    );

    const wholesale = Number(
      drug.wholesalePrice ?? drug.wholesale_price ?? 0
    );

    const activePrice =
      saleType === 'wholesale'
        ? wholesale
        : retail;

    const existingIndex = cart.findIndex(
      (item) =>
        String(item.id) === String(drug.id)
    );

    if (existingIndex > -1) {
      const updated = [...cart];

      updated[existingIndex].quantity += 1;

      setCart(updated);
    } else {
      setCart([
        ...cart,
        {
          ...drug,
          activePrice,
          quantity: 1
        }
      ]);
    }
  };

  const handleSaleTypeChange = (type) => {
    setSaleType(type);

    if (cart.length > 0) {
      setCart(
        cart.map((item) => {
          const retail = Number(
            item.retailPrice ??
              item.retail_price ??
              0
          );

          const wholesale = Number(
            item.wholesalePrice ??
              item.wholesale_price ??
              0
          );

          return {
            ...item,
            activePrice:
              type === 'wholesale'
                ? wholesale
                : retail
          };
        })
      );
    }
  };

  const updateQuantity = (id, delta) => {
    setCart(
      cart
        .map((item) => {
          if (String(item.id) === String(id)) {
            const newQty =
              item.quantity + delta;

            return newQty > 0
              ? {
                  ...item,
                  quantity: newQty
                }
              : null;
          }

          return item;
        })
        .filter(Boolean)
    );
  };

  // Half-pack/pack pricing is optional per drug (packQty/packPrice and
  // halfPackQty/halfPackPrice are blank unless a manager filled them
  // in). When they ARE set, this greedily breaks a line's quantity into
  // as many full packs as fit, then as many half packs as fit the
  // remainder, pricing the rest at the normal per-unit price — so a
  // cart of 14 units with pack=12@2000 and half=6@1000 prices as one
  // pack (2000) + 2 units at the per-unit rate, not 14 × per-unit.
  const computePackPricing = (item) => {
    const unitPrice = item.activePrice || 0;
    const packQty = Number(item.packQty) || 0;
    const packPrice = Number(item.packPrice) || 0;
    const halfQty = Number(item.halfPackQty) || 0;
    const halfPrice = Number(item.halfPackPrice) || 0;

    let remaining = item.quantity;
    let total = 0;
    let packsUsed = 0;
    let halvesUsed = 0;

    if (packQty > 0 && packPrice > 0) {
      packsUsed = Math.floor(remaining / packQty);
      total += packsUsed * packPrice;
      remaining -= packsUsed * packQty;
    }

    if (halfQty > 0 && halfPrice > 0) {
      halvesUsed = Math.floor(remaining / halfQty);
      total += halvesUsed * halfPrice;
      remaining -= halvesUsed * halfQty;
    }

    total += remaining * unitPrice;

    return {
      total,
      packsUsed,
      halvesUsed,
      remainingUnits: remaining,
      hasDiscount: packsUsed > 0 || halvesUsed > 0
    };
  };

  const cartTotal = cart.reduce(
    (sum, item) =>
      sum + computePackPricing(item).total,
    0
  );

  // A cart line currently carries the ENTIRE drug record (cost price,
  // stock, barcode, etc — everything addToCart spread in). None of that
  // belongs in a saved sale: the receipt, Sales History and the Admin
  // audit log only ever read name/unitType/quantity/activePrice, and
  // storing the rest roughly doubles every sale row's size for no
  // benefit — while also leaking cost prices into records a
  // salesperson's own sales end up sitting next to. This keeps only
  // what's actually displayed anywhere downstream.
  const slimCartItems = (items) =>
    items.map((item) => ({
      id: item.id,
      name: item.name,
      unitType: item.unitType || item.unit_type || 'Sachet',
      quantity: item.quantity,
      activePrice: item.activePrice || 0,
      // Snapshot the pack-discounted total at sale time, so a receipt or
      // history record still shows what was actually charged even if
      // the drug's pack pricing is edited later.
      lineTotal: computePackPricing(item).total,
      // Snapshot the cost price too — the admin dashboard's profit
      // figures need what this item actually cost AT THE TIME OF SALE,
      // not whatever the drug's cost price has drifted to since.
      costPrice: Number(item.costPrice ?? item.cost_price ?? 0)
    }));

  // ============================================================
  // TICKET DRAFTS (attendant building carts for the cashier workflow)
  // Each draft is an isolated cart — its own items/customer/saleType —
  // so several customers can be worked on at once. Nothing here is
  // persisted until handleSubmitTicket runs.
  // ============================================================
  // Draft labels count up A, B, C, ... Z, AA, AB, ... and never reuse a
  // letter within a session, even if an earlier draft was closed — so
  // two customers being worked on "at the same time" never end up
  // sharing a label just because one finished first.
  const draftLetterCounterRef = useRef(0);

  const nextDraftLetter = () => {
    let n = draftLetterCounterRef.current;
    draftLetterCounterRef.current += 1;

    let label = '';
    do {
      label = String.fromCharCode(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);

    return label;
  };

  const createNewDraft = () => {
    const draftId = `draft-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const label = `Customer ${nextDraftLetter()}`;

    setTicketDrafts((prev) => [
      ...prev,
      {
        id: draftId,
        items: [],
        customerName: label,
        customerPhone: '',
        saleType
      }
    ]);

    setActiveDraftId(draftId);
  };

  const closeDraft = (draftId) => {
    setTicketDrafts((prev) => {
      const remaining = prev.filter((d) => d.id !== draftId);

      if (activeDraftId === draftId) {
        setActiveDraftId(remaining.length > 0 ? remaining[0].id : null);
      }

      return remaining;
    });
  };

  // ============================================================
  // SAVED CART DRAFTS (set a cart aside, continue with it later)
  // ============================================================
  const handleLoadSavedCartDrafts = async () => {
    const list = await fetchSavedCartDrafts(session?.user?.email);
    setSavedCartDrafts(list);
  };

  const handleOpenSavedCartsPanel = () => {
    setIsSavedCartsPanelOpen(true);
    handleLoadSavedCartDrafts();
  };

  // Writes the draft to local storage and removes it from the open
  // tabs — same "set it aside" action whether the cart is empty or
  // full, since the point is freeing up a tab, not validating content.
  const handleSaveDraftForLater = async (draftId) => {
    const draft = ticketDrafts.find((d) => d.id === draftId);
    if (!draft) return;
    if (draft.items.length === 0) {
      alert("This cart is empty — add something first, or just close it with the × instead of saving it.");
      return;
    }
    setIsSavingCartDraft(true);
    try {
      const result = await saveCartDraft(draft, {
        email: session?.user?.email,
        role: userRole
      });
      if (result.success) {
        closeDraft(draftId);
        if (isSavedCartsPanelOpen) handleLoadSavedCartDrafts();
      } else {
        alert(result.reason || 'Unable to save this cart.');
      }
    } finally {
      setIsSavingCartDraft(false);
    }
  };

  // Brings a saved cart back as a live, editable draft tab — reusing
  // the same ticketDrafts array a freshly-built cart would use — and
  // removes it from saved storage so it isn't sitting in both places.
  const handleResumeSavedCartDraft = async (saved) => {
    setTicketDrafts((prev) => [
      ...prev,
      {
        id: saved.id,
        items: saved.items || [],
        customerName: saved.customerName || 'Saved cart',
        customerPhone: saved.customerPhone || '',
        saleType: saved.saleType || 'retail'
      }
    ]);
    setActiveDraftId(saved.id);
    setIsSavedCartsPanelOpen(false);
    await deleteCartDraft(saved.id);
    setSavedCartDrafts((prev) => prev.filter((d) => d.id !== saved.id));
  };

  const handleDiscardSavedCartDraft = async (saved) => {
    if (!window.confirm(`Discard the saved cart for "${saved.label || saved.customerName}"? This cannot be undone.`)) {
      return;
    }
    await deleteCartDraft(saved.id);
    setSavedCartDrafts((prev) => prev.filter((d) => d.id !== saved.id));
  };

  const addToDraft = (draftId, drug) => {
    // A drug with zero stock on record can't actually be sold — rather
    // than silently letting it onto a ticket (which a cashier would
    // only discover was impossible to fulfil later), tell the
    // salesperson right away with a brief, self-dismissing message.
    if (Number(drug.stock || 0) <= 0) {
      setStockWarning(`${drug.name} is out of stock — can't be sold right now.`);
      if (stockWarningTimeoutRef.current) clearTimeout(stockWarningTimeoutRef.current);
      stockWarningTimeoutRef.current = setTimeout(() => setStockWarning(''), 3000);
      return;
    }

    setLastAddedItemId(drug.id);
    if (lastAddedTimeoutRef.current) clearTimeout(lastAddedTimeoutRef.current);
    lastAddedTimeoutRef.current = setTimeout(() => setLastAddedItemId(null), 900);

    setTicketDrafts((prev) =>
      prev.map((d) => {
        if (d.id !== draftId) return d;

        const retail = Number(drug.retailPrice ?? drug.retail_price ?? 0);
        const wholesale = Number(
          drug.wholesalePrice ?? drug.wholesale_price ?? 0
        );
        const activePrice = d.saleType === 'wholesale' ? wholesale : retail;

        const idx = d.items.findIndex(
          (item) => String(item.id) === String(drug.id)
        );

        if (idx > -1) {
          const items = [...d.items];
          items[idx] = {
            ...items[idx],
            quantity: items[idx].quantity + 1
          };
          return { ...d, items };
        }

        return {
          ...d,
          items: [...d.items, { ...drug, activePrice, quantity: 1 }]
        };
      })
    );
  };

  const updateDraftQuantity = (draftId, itemId, delta) => {
    setTicketDrafts((prev) =>
      prev.map((d) => {
        if (d.id !== draftId) return d;

        const items = d.items
          .map((item) => {
            if (String(item.id) !== String(itemId)) return item;
            const newQty = item.quantity + delta;
            return newQty > 0 ? { ...item, quantity: newQty } : null;
          })
          .filter(Boolean);

        return { ...d, items };
      })
    );
  };

  const setDraftField = (draftId, field, value) => {
    setTicketDrafts((prev) =>
      prev.map((d) => (d.id === draftId ? { ...d, [field]: value } : d))
    );
  };

  const setDraftSaleType = (draftId, type) => {
    setTicketDrafts((prev) =>
      prev.map((d) => {
        if (d.id !== draftId) return d;

        const items = d.items.map((item) => {
          const retail = Number(item.retailPrice ?? item.retail_price ?? 0);
          const wholesale = Number(
            item.wholesalePrice ?? item.wholesale_price ?? 0
          );
          return {
            ...item,
            activePrice: type === 'wholesale' ? wholesale : retail
          };
        });

        return { ...d, saleType: type, items };
      })
    );
  };

  const draftTotal = (draft) =>
    draft.items.reduce((sum, item) => sum + computePackPricing(item).total, 0);

  const activeDraft = ticketDrafts.find((d) => d.id === activeDraftId) || null;

  const handleSubmitTicket = async (draftId) => {
    const draft = ticketDrafts.find((d) => d.id === draftId);
    if (!draft || draft.items.length === 0) return;

    // Defense in depth, separate from whatever fixed the root cause: a
    // cart whose total came out to ₦0 or less never reaches the cashier
    // — someone would end up approving a "payment" of nothing and
    // printing a real receipt for it. If this ever fires, something
    // upstream computed a price wrong; better to block the ticket here
    // than let a free sale through.
    const total = draftTotal(draft);
    if (total <= 0) {
      alert(
        `This ticket's total came out to ₦${total.toLocaleString()}, which can't be right. Check that every item has a real retail/wholesale price before sending it to the cashier.`
      );
      return;
    }

    // Wholesale pricing and owing are separate things now — a cart at
    // wholesale prices can go straight to the cashier with no customer
    // record at all. A customer only gets attached (by the cashier, at
    // approval time) if this person wants to owe and pay later.
    setIsSubmittingTicket(true);

    try {
      const ticketPayload = {
        items: slimCartItems(draft.items),
        total,
        saleType: draft.saleType,
        customerName: draft.customerName.trim() || 'Walk-in Customer',
        customerPhone: draft.customerPhone.trim() || 'N/A',
        customerId: draft.saleType === 'wholesale' ? draft.customerId || null : null,
        attendantId: session?.user?.id,
        attendantEmail: session?.user?.email
      };

      // A reopened "sent back" draft resubmits onto the SAME ticket
      // (same id, same daily number — it already had its place in
      // line), rather than creating a brand-new one.
      const result = draft.resubmitOf
        ? await resubmitTicket(draft.resubmitOf, ticketPayload, {
            email: session?.user?.email,
            role: userRole
          })
        : await createTicket(ticketPayload, {
            email: session?.user?.email,
            role: userRole
          });

      if (result.success) {
        closeDraft(draftId);
        setPrintingTicket(result.ticket);
      } else {
        alert(result.reason || 'Unable to submit this ticket.');
      }
    } finally {
      setIsSubmittingTicket(false);
    }
  };

  // ============================================================
  // CASHIER: APPROVE / CANCEL TICKETS
  // ============================================================
  const handleOpenApproveModal = (ticket) => {
    setApprovingTicket(ticket);
    setPaymentMethod('cash');
    setPaymentCash(String(ticket.total || ''));
    setPaymentElectronicLines([]);
    setIsLinkingCustomerForApproval(false);
    setApprovalCustomerSearchTerm('');
    setCustomerPickerForApproval(false);
  };

  // Switching the top-level method sets sensible defaults but never
  // picks a bank for the cashier — that choice is always explicit, and
  // handleConfirmApproval refuses to approve without it.
  const handleSelectPaymentMethod = (method) => {
    setPaymentMethod(method);
    if (method === 'cash') {
      setPaymentCash(String(approvingTicket?.total || ''));
      setPaymentElectronicLines([]);
    } else if (method === 'card' || method === 'transfer') {
      setPaymentCash('');
      setPaymentElectronicLines([
        { id: `line-${Date.now()}`, type: method, bank: '', amount: String(approvingTicket?.total || '') }
      ]);
    } else {
      // Split — start empty, cashier builds it up line by line.
      setPaymentCash('');
      setPaymentElectronicLines([]);
    }
  };

  const handleAddElectronicLine = (type) => {
    setPaymentElectronicLines((prev) => [
      ...prev,
      { id: `line-${Date.now()}-${Math.floor(Math.random() * 1000)}`, type, bank: '', amount: '' }
    ]);
  };

  const handleUpdateElectronicLine = (id, changes) => {
    setPaymentElectronicLines((prev) =>
      prev.map((line) => (line.id === id ? { ...line, ...changes } : line))
    );
  };

  const handleRemoveElectronicLine = (id) => {
    setPaymentElectronicLines((prev) => prev.filter((line) => line.id !== id));
  };

  const handleConfirmApproval = async () => {
    if (!approvingTicket) return;

    // Same defense-in-depth as the submit side: a ticket that somehow
    // made it into the queue with a ₦0 (or negative) total gets refused
    // here too, rather than letting a cashier approve "payment" of
    // nothing and hand out a real receipt for it.
    if (!approvingTicket.total || approvingTicket.total <= 0) {
      alert(
        `This ticket's total is ₦${(approvingTicket.total || 0).toLocaleString()}, which can't be approved. Send it back to the attendant to fix the pricing instead.`
      );
      return;
    }

    const cash = Number(paymentCash) || 0;
    const electronicLines = paymentElectronicLines.map((line) => ({
      ...line,
      amount: Number(line.amount) || 0
    }));

    // Every card/transfer line with money against it needs a bank —
    // this is the actual fix for being able to approve (and print a
    // receipt) without ever choosing one: previously the bank dropdown
    // silently defaulted to the first bank in the list the moment the
    // modal opened, so the check for "is a bank chosen" never failed.
    // Now nothing is pre-selected, so a missing choice is really missing.
    const lineMissingBank = electronicLines.find(
      (line) => line.amount > 0 && !line.bank
    );
    if (lineMissingBank) {
      alert(
        `Select which bank the ${lineMissingBank.type === 'card' ? 'card' : 'transfer'} payment of ₦${lineMissingBank.amount.toLocaleString()} went through.`
      );
      return;
    }

    const electronicTotal = electronicLines.reduce((sum, line) => sum + line.amount, 0);
    const sum = cash + electronicTotal;

    const isWholesaleWithCustomer =
      approvingTicket.saleType === 'wholesale' && approvingTicket.customerId;

    if (isWholesaleWithCustomer) {
      // A wholesale customer is allowed to owe — that's the incentive
      // to keep buying — but whatever they already owed coming in has
      // to be cleared first. The new ticket's own total can go fully
      // or partly unpaid; only the OLD balance is a hard floor.
      const customer = customersById.get(String(approvingTicket.customerId));
      const minimumRequired = getMinimumWholesalePayment(customer);
      if (sum + 1 < minimumRequired) {
        alert(
          `${approvingTicket.customerName} still owes ₦${minimumRequired.toLocaleString()} from before — at least that much has to be paid before this sale can go through. Collect ₦${minimumRequired.toLocaleString()} or more, or send this ticket back to the salesperson.`
        );
        return;
      }
    } else {
      // Allow a 1-naira tolerance for rounding, not more — a payment
      // short or over the ticket total is exactly the kind of mistake
      // this split-role workflow exists to catch before it leaves the
      // till.
      if (Math.abs(sum - approvingTicket.total) > 1) {
        alert(
          `Payment entered (₦${sum.toLocaleString()}) doesn't match the ticket total (₦${approvingTicket.total.toLocaleString()}). Adjust the amounts so they add up exactly.`
        );
        return;
      }
    }

    setIsApprovingTicket(true);

    try {
      const paymentBreakdown = {
        method: paymentMethod,
        cash,
        electronic: electronicLines
          .filter((line) => line.amount > 0)
          .map((line) => ({ type: line.type, bank: line.bank, amount: line.amount }))
      };

      const result = await approveTicket(approvingTicket, paymentBreakdown, {
        id: session?.user?.id,
        email: session?.user?.email,
        role: userRole
      });

      if (result.success) {
        setApprovingTicket(null);
        setSaleSuccessData(result.sale);
        setShowReceiptModal(true);
      } else if (result.insufficientWholesalePayment) {
        // Defense in depth — the same check already ran client-side
        // above, but the server-side numbers are the ones that count if
        // the customer's balance changed from another device in the
        // meantime.
        alert(
          result.reason ||
            `At least ₦${result.minimumRequired.toLocaleString()} has to be paid before this sale can go through.`
        );
      } else {
        alert(result.reason || 'Unable to approve this ticket.');
      }
    } finally {
      setIsApprovingTicket(false);
    }
  };

  const handleCancelTicketClick = async (ticket) => {
    if (
      !window.confirm(
        `Cancel this ₦${ticket.total.toLocaleString()} ticket for ${ticket.customerName}? This cannot be undone.`
      )
    ) {
      return;
    }

    await cancelTicket(ticket, {
      email: session?.user?.email,
      role: userRole
    });
  };

  // ============================================================
  // CASHIER: SEND TICKET BACK FOR ADJUSTMENT
  // (no drug/quantity editing happens on the cashier's side — this just
  // flags the ticket back to the attendant who built it)
  // ============================================================
  const handleOpenSendBackModal = (ticket) => {
    setSendingBackTicket(ticket);
    setSendBackReason('');
  };

  const handleConfirmSendBack = async () => {
    if (!sendingBackTicket) return;

    if (!sendBackReason.trim()) {
      alert('Enter a short reason so the attendant knows what to fix.');
      return;
    }

    setIsSendingBackTicket(true);

    try {
      const result = await sendTicketBack(sendingBackTicket, sendBackReason, {
        email: session?.user?.email,
        role: userRole
      });

      if (result.success) {
        setSendingBackTicket(null);
        setSendBackReason('');
      } else {
        alert(result.reason || 'Unable to send this ticket back.');
      }
    } finally {
      setIsSendingBackTicket(false);
    }
  };

  // Attendant reopening a SENT_BACK ticket: turns it back into a live,
  // editable draft (same drafts array single-cart-at-a-time builder used
  // for a fresh ticket), tagged with `resubmitOf` so handleSubmitTicket
  // below knows to call resubmitTicket (same ticket id/daily number)
  // instead of createTicket (a brand-new one).
  const handleReopenSentBackTicket = (ticket) => {
    // A ticket already reopened into a draft shouldn't get a second,
    // duplicate draft from clicking "Reopen & Edit" again — that left
    // two drafts racing to resubmit the same ticket. Just bring the
    // existing one into focus instead.
    const existingDraft = ticketDrafts.find((d) => d.resubmitOf === ticket.id);
    if (existingDraft) {
      setActiveDraftId(existingDraft.id);
      return;
    }

    const draftId = `draft-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    // A ticket's own items are a SLIMMED snapshot (id/name/unitType/
    // quantity/activePrice/lineTotal only — see slimCartItems below) with
    // no retailPrice/wholesalePrice/pack fields on them at all. Re-hydrate
    // each line from the live catalog by id so retail/wholesale toggling
    // on the reopened draft has real numbers to compute from — this is
    // exactly what was making every price collapse to ₦0 the instant the
    // toggle was touched: setDraftSaleType reads item.retailPrice /
    // item.wholesalePrice, both undefined on a bare snapshot, so it fell
    // back to 0 for whichever one wasn't already showing.
    const rehydratedItems = (ticket.items || []).map((snapshotItem) => {
      const liveDrug = (drugs || []).find(
        (d) => String(d.id) === String(snapshotItem.id)
      );

      if (liveDrug) {
        return {
          ...liveDrug,
          quantity: snapshotItem.quantity,
          activePrice:
            ticket.saleType === 'wholesale'
              ? Number(liveDrug.wholesalePrice ?? 0)
              : Number(liveDrug.retailPrice ?? 0)
        };
      }

      // The drug was deleted from the catalog since this ticket was
      // built — keep the snapshot, but carry its last known price into
      // BOTH retail/wholesale slots so toggling still shows a real
      // number instead of zeroing out.
      return {
        ...snapshotItem,
        retailPrice: snapshotItem.activePrice || 0,
        wholesalePrice: snapshotItem.activePrice || 0
      };
    });

    setTicketDrafts((prev) => [
      ...prev,
      {
        id: draftId,
        items: rehydratedItems,
        customerName: ticket.customerName || `Customer ${nextDraftLetter()}`,
        customerPhone: ticket.customerPhone || '',
        // Carried over so a reopened wholesale ticket keeps its linked
        // customer record (and their running balance) instead of
        // silently losing it and getting blocked on resubmit for
        // "no customer chosen" on a ticket that already had one.
        customerId: ticket.customerId || null,
        saleType: ticket.saleType || 'retail',
        resubmitOf: ticket.id
      }
    ]);

    setActiveDraftId(draftId);
  };

  // "Discard" on a sent-back ticket: the attendant decides the ticket
  // shouldn't come back at all (customer left, duplicate, etc.) rather
  // than reopening it — cancels it outright, same as cancelling any
  // other ticket.
  const handleDiscardSentBackTicket = async (ticket) => {
    if (
      !window.confirm(
        `Discard this ₦${ticket.total.toLocaleString()} ticket for ${ticket.customerName}? This cannot be undone.`
      )
    ) {
      return;
    }

    await cancelTicket(ticket, {
      email: session?.user?.email,
      role: userRole
    });
  };

  // ============================================================
  // RESTOCK FROM SUPPLIER
  // ============================================================
  const handleSaveNewSupplier = async () => {
    if (!newSupplierForm.name.trim()) {
      alert("Enter the supplier's name.");
      return;
    }

    setIsSavingSupplier(true);
    try {
      const supplier = await addSupplier(newSupplierForm, {
        email: session?.user?.email,
        role: userRole
      });
      setRestockSupplierId(supplier.id);
      setNewSupplierForm({
        name: '',
        contactPerson: '',
        phone: '',
        email: '',
        address: ''
      });
    } finally {
      setIsSavingSupplier(false);
    }
  };

  // ============================================================
  // SUPPLIERS CRUD (the standalone Suppliers sub-tab — separate from
  // the inline "new supplier while restocking" form above, though both
  // ultimately write to the same `suppliers` table via the same db.js
  // functions).
  // ============================================================
  const handleOpenAddSupplierModal = () => {
    setEditingSupplier(null);
    setSupplierFormData({ name: '', contactPerson: '', phone: '', email: '', address: '' });
    setIsSupplierModalOpen(true);
  };

  const handleOpenEditSupplierModal = (supplier) => {
    setEditingSupplier(supplier);
    setSupplierFormData({
      name: supplier.name || '',
      contactPerson: supplier.contactPerson || supplier.contact_person || '',
      phone: supplier.phone || '',
      email: supplier.email || '',
      address: supplier.address || ''
    });
    setIsSupplierModalOpen(true);
  };

  const handleSaveSupplier = async (e) => {
    e.preventDefault();
    if (!supplierFormData.name.trim()) {
      alert("Enter the supplier's name.");
      return;
    }
    setIsSavingSupplierCrud(true);
    try {
      const actor = { email: session?.user?.email, role: userRole };
      if (editingSupplier) {
        const result = await updateSupplier(editingSupplier, supplierFormData, actor);
        setIsSupplierModalOpen(false);
        if (result && result.pending) {
          alert(
            `Your changes to "${supplierFormData.name}" have been sent to a manager for approval.`
          );
        } else if (result && result.success === false) {
          alert(result.reason || 'Unable to save this supplier.');
        }
      } else {
        await addSupplier(supplierFormData, actor);
        setIsSupplierModalOpen(false);
      }
    } finally {
      setIsSavingSupplierCrud(false);
    }
  };

  // Called by the confirm-delete modal's "Delete" button, for a target
  // of kind 'supplier'.
  const handleConfirmDeleteSupplier = async (supplier) => {
    const actor = { email: session?.user?.email, role: userRole };
    const result = await requestDeleteSupplier(supplier, actor);
    if (result && result.success === false) {
      alert(result.reason || 'Unable to delete this supplier.');
      return;
    }
    if (result && result.pending) {
      alert(
        `"${supplier.name}" won't be deleted until a manager approves it — it's been sent to them for review.`
      );
    }
  };

  // ============================================================
  // WHOLESALE CUSTOMERS CRUD — same shape as suppliers above.
  // ============================================================
  const handleOpenAddCustomerModal = () => {
    setEditingCustomer(null);
    setCustomerFormData({ name: '', phones: [''], email: '', address: '' });
    setIsCustomerModalOpen(true);
  };

  const handleOpenEditCustomerModal = (customer) => {
    setEditingCustomer(customer);
    setCustomerFormData({
      name: customer.name || '',
      phones:
        Array.isArray(customer.phones) && customer.phones.length > 0
          ? customer.phones
          : customer.phone
            ? [customer.phone]
            : [''],
      email: customer.email || '',
      address: customer.address || ''
    });
    setIsCustomerModalOpen(true);
  };

  const handleSaveCustomer = async (e) => {
    e.preventDefault();
    if (!customerFormData.name.trim()) {
      alert("Enter the customer's name.");
      return;
    }
    setIsSavingCustomerCrud(true);
    try {
      const actor = { email: session?.user?.email, role: userRole };
      const payload = {
        ...customerFormData,
        phones: (customerFormData.phones || []).map((p) => p.trim()).filter(Boolean)
      };
      if (editingCustomer) {
        const result = await updateCustomer(editingCustomer, payload, actor);
        setIsCustomerModalOpen(false);
        if (result && result.pending) {
          alert(
            `Your changes to "${payload.name}" have been sent to a manager for approval.`
          );
        } else if (result && result.success === false) {
          alert(result.reason || 'Unable to save this customer.');
        }
      } else {
        const result = await addCustomer(payload, actor);
        setIsCustomerModalOpen(false);
        if (result.success === false) {
          alert(result.reason || 'Unable to save this customer.');
        } else if (result.pending) {
          // Cashier-submitted — nothing exists yet for this person to
          // owe against. A manager has to sign off first.
          alert(
            `"${payload.name}" has been sent to a manager for approval. They can't owe anything until that's approved — if this was for a sale in progress, it still needs to be paid in full for now.`
          );
          setCustomerPickerForApproval(false);
        } else if (result.applied && result.customer) {
          // Manager/administrator created it directly — it's usable
          // right away. If this was opened from the approval modal's
          // "+ New Customer" shortcut, link it onto that ticket now
          // instead of making the cashier search for it again.
          if (customerPickerForApproval) {
            await handleLinkExistingCustomerForApproval(result.customer);
          }
          setCustomerPickerForApproval(false);
        }
      }
    } finally {
      setIsSavingCustomerCrud(false);
    }
  };

  const handleConfirmDeleteCustomer = async (customer) => {
    const actor = { email: session?.user?.email, role: userRole };
    const result = await requestDeleteCustomer(customer, actor);
    if (result && result.success === false) {
      alert(result.reason || 'Unable to delete this customer.');
      return;
    }
    if (result && result.pending) {
      alert(
        `"${customer.name}" won't be deleted until a manager approves it — it's been sent to them for review.`
      );
    }
  };

  // The cashier approval modal's counterpart to picking a drug — links
  // an already-approved customer record onto the ticket being paid
  // for, which is what unlocks owing. A brand-new/unapproved customer
  // (see addCustomer above) never reaches here — only one that already
  // exists in `customers` can be linked.
  const handleLinkExistingCustomerForApproval = async (customer) => {
    if (!approvingTicket) return;
    const result = await linkCustomerToTicket(approvingTicket, customer.id, {
      email: session?.user?.email,
      role: userRole
    });
    if (result.success) {
      setApprovingTicket(result.ticket);
      setIsLinkingCustomerForApproval(false);
      setApprovalCustomerSearchTerm('');
    } else {
      alert(result.reason || 'Unable to link this customer.');
    }
  };

  // ============================================================
  // PURCHASE LIST — every change here writes straight to that drug's
  // purchasePlans row. There's no draft/save step: the list on screen
  // IS the current plan.
  // ============================================================
  const handleUpdatePlanQuantity = (drugId, quantity) => {
    const actor = { email: session?.user?.email, role: userRole };
    savePurchasePlan(drugId, { quantity: Math.max(1, Number(quantity) || 1) }, actor);
  };

  const handleUpdatePlanUnitCost = (drugId, unitCost) => {
    const actor = { email: session?.user?.email, role: userRole };
    savePurchasePlan(drugId, { unitCost: Math.max(0, Number(unitCost) || 0) }, actor);
  };

  // A manual pick is sticky — it stops tracking "last supplier bought
  // from" until explicitly cleared, per "should only be a change if I
  // click on the option to choose the supplier."
  const handlePickPlanSupplier = (drugId, supplier) => {
    const actor = { email: session?.user?.email, role: userRole };
    savePurchasePlan(
      drugId,
      { supplierId: supplier.id, supplierName: supplier.name, supplierManual: true },
      actor
    );
    setSupplierPickerForDrugId(null);
  };

  const handleClearPlanSupplierOverride = (drugId) => {
    const actor = { email: session?.user?.email, role: userRole };
    savePurchasePlan(
      drugId,
      { supplierId: null, supplierName: null, supplierManual: false },
      actor
    );
    setSupplierPickerForDrugId(null);
  };

  const handleExcludeFromPurchaseList = (drugId) => {
    const actor = { email: session?.user?.email, role: userRole };
    savePurchasePlan(drugId, { excluded: true }, actor);
  };

  const handleReturnToPurchaseList = (drugId) => {
    const actor = { email: session?.user?.email, role: userRole };
    savePurchasePlan(drugId, { excluded: false }, actor);
  };

  const handleOpenPrintPurchasePlan = () => {
    setPrintingPurchasePlan(purchaseListGroupedBySupplier(purchaseNeedsList));
  };

  // Adding a drug already in the catalog to the restock cart — cost
  // price defaults to what's already on file but stays editable, since
  // this particular supplier/delivery may charge differently.
  const handleAddExistingDrugToRestock = (drug) => {
    setRestockCart((prev) => {
      const idx = prev.findIndex(
        (item) => !item.isNewDrug && String(item.drugId) === String(drug.id)
      );
      if (idx > -1) {
        const updated = [...prev];
        updated[idx] = {
          ...updated[idx],
          quantity: Number(updated[idx].quantity || 0) + 1
        };
        return updated;
      }

      return [
        ...prev,
        {
          drugId: drug.id,
          isNewDrug: false,
          name: drug.name,
          unitType: drug.unitType,
          quantity: 1,
          // Pre-filled from what's already on file so the common case
          // (this delivery is priced the same as last time) needs no
          // typing — but all three stay editable in case this supplier
          // or delivery charges differently.
          costPrice: drug.costPrice ?? 0,
          retailPrice: drug.retailPrice ?? 0,
          wholesalePrice: drug.wholesalePrice ?? 0
        }
      ];
    });
  };

  const handleAddNewDrugLineToRestock = () => {
    const name = newDrugLine.name.trim();
    const quantity = Number(newDrugLine.quantity) || 0;

    if (!name) {
      alert("Enter the new drug's name.");
      return;
    }
    if (quantity <= 0) {
      alert('Enter a quantity greater than 0.');
      return;
    }

    // Blank stays null rather than 0 — same convention as the main Add
    // Drug form, so an empty pack field never gets mistaken for a free
    // pack.
    const optionalNumber = (value) =>
      value === '' || value === null || value === undefined ? null : Number(value);

    setRestockCart((prev) => [
      ...prev,
      {
        drugId: null,
        isNewDrug: true,
        name,
        unitType: newDrugLine.unitType || 'Unit',
        quantity,
        costPrice: Number(newDrugLine.costPrice) || 0,
        retailPrice: Number(newDrugLine.retailPrice) || 0,
        wholesalePrice: Number(newDrugLine.wholesalePrice) || 0,
        barcode: newDrugLine.barcode.trim(),
        halfPackQty: optionalNumber(newDrugLine.halfPackQty),
        halfPackPrice: optionalNumber(newDrugLine.halfPackPrice),
        packQty: optionalNumber(newDrugLine.packQty),
        packPrice: optionalNumber(newDrugLine.packPrice)
      }
    ]);

    setNewDrugLine({
      name: '',
      unitType: 'Unit',
      quantity: '',
      costPrice: '',
      retailPrice: '',
      wholesalePrice: '',
      barcode: '',
      halfPackQty: '',
      halfPackPrice: '',
      packQty: '',
      packPrice: ''
    });
    setShowNewDrugForm(false);
  };

  const updateRestockLine = (index, field, value) => {
    setRestockCart((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: value } : item))
    );
  };

  const removeRestockLine = (index) => {
    setRestockCart((prev) => prev.filter((_, i) => i !== index));
  };

  const restockTotalCost = React.useMemo(
    () =>
      restockCart.reduce(
        (sum, item) =>
          sum + Number(item.quantity || 0) * Number(item.costPrice || 0),
        0
      ),
    [restockCart]
  );

  const selectedSupplier =
    suppliers?.find((s) => s.id === restockSupplierId) || null;

  const handleSubmitStockEntry = async () => {
    if (restockSupplierId === '__new__' || !selectedSupplier) {
      alert('Select or add a supplier first.');
      return;
    }
    if (restockCart.length === 0) {
      alert('Add at least one drug to this stock entry.');
      return;
    }

    // Any new-drug line needs real retail/wholesale prices before it can
    // become an actual catalog entry — quantity and cost alone aren't
    // enough to sell it afterward.
    const incompleteNewDrug = restockCart.find(
      (item) =>
        item.isNewDrug &&
        (!item.retailPrice || !item.wholesalePrice)
    );
    if (incompleteNewDrug) {
      alert(
        `"${incompleteNewDrug.name}" is missing a retail or wholesale price — every new drug needs both before it can be added.`
      );
      return;
    }

    setIsSubmittingStockEntry(true);
    try {
      const result = await createStockEntry(
        {
          supplierId: selectedSupplier.id,
          supplierName: selectedSupplier.name,
          items: restockCart.map((item) => ({
            drugId: item.drugId,
            isNewDrug: item.isNewDrug,
            name: item.name,
            unitType: item.unitType,
            quantity: Number(item.quantity) || 0,
            costPrice: Number(item.costPrice) || 0,
            // Retail/wholesale travel with every line now, not just new
            // drugs — an existing drug's restock line can correct its
            // price too, defaulting to what was already on file.
            retailPrice:
              item.retailPrice !== '' && item.retailPrice !== undefined
                ? Number(item.retailPrice) || 0
                : undefined,
            wholesalePrice:
              item.wholesalePrice !== '' && item.wholesalePrice !== undefined
                ? Number(item.wholesalePrice) || 0
                : undefined,
            barcode: item.isNewDrug ? item.barcode || '' : undefined,
            halfPackQty: item.isNewDrug ? item.halfPackQty ?? null : undefined,
            halfPackPrice: item.isNewDrug ? item.halfPackPrice ?? null : undefined,
            packQty: item.isNewDrug ? item.packQty ?? null : undefined,
            packPrice: item.isNewDrug ? item.packPrice ?? null : undefined
          })),
          totalCost: restockTotalCost,
          amountPaid: Math.min(
            Number(restockAmountPaid) || 0,
            restockTotalCost
          )
        },
        { id: session?.user?.id, email: session?.user?.email, role: userRole }
      );

      if (result.success) {
        const applied = result.entry.status === 'APPLIED';
        alert(
          applied
            ? `Stock updated — ${restockCart.length} line item(s) from ${selectedSupplier.name}.`
            : `Sent to a manager for approval — ${restockCart.length} line item(s) from ${selectedSupplier.name}.`
        );
        setRestockCart([]);
        setRestockAmountPaid('');
        setRestockSupplierId('');
        // The draft this was built from is now a real submitted entry —
        // nothing left to resume, so clear it rather than leaving a
        // stale (now-redundant) draft sitting around for next time.
        if (session?.user?.email) {
          clearRestockDraft(session.user.email);
        }
      } else {
        alert(result.reason || 'Unable to submit this stock entry.');
      }
    } finally {
      setIsSubmittingStockEntry(false);
    }
  };

  const handleConfirmRecordPayment = async () => {
    if (!recordingPaymentFor) return;
    const amount = Number(recordPaymentAmount) || 0;
    if (amount <= 0) {
      alert('Enter an amount greater than 0.');
      return;
    }
    setIsRecordingPayment(true);
    try {
      const result = await recordSupplierPayment(recordingPaymentFor, amount, {
        email: session?.user?.email,
        role: userRole
      });
      if (result.success) {
        setRecordingPaymentFor(null);
        setRecordPaymentAmount('');
      } else {
        alert(result.reason || 'Unable to record this payment.');
      }
    } finally {
      setIsRecordingPayment(false);
    }
  };

  const handleApproveStockEntry = async (entry) => {
    if (
      !window.confirm(
        `Approve this ₦${entry.totalCost.toLocaleString()} stock entry from ${entry.supplierName}? Stock will be updated immediately.`
      )
    ) {
      return;
    }

    const result = await approveStockEntry(entry, {
      email: session?.user?.email,
      role: userRole
    });

    if (!result.success) {
      alert(result.reason || 'Unable to approve this stock entry.');
    }
  };

  const handleOpenRejectStockModal = (entry) => {
    setRejectingStockEntry(entry);
    setStockRejectReason('');
  };

  const handleConfirmRejectStockEntry = async () => {
    if (!rejectingStockEntry) return;
    if (!stockRejectReason.trim()) {
      alert('Enter a short reason so the person who entered it knows why.');
      return;
    }

    setIsRejectingStockEntry(true);
    try {
      const result = await rejectStockEntry(
        rejectingStockEntry,
        stockRejectReason,
        { email: session?.user?.email, role: userRole }
      );
      if (result.success) {
        setRejectingStockEntry(null);
        setStockRejectReason('');
      } else {
        alert(result.reason || 'Unable to reject this stock entry.');
      }
    } finally {
      setIsRejectingStockEntry(false);
    }
  };

  // ============================================================
  // EDITING AN ALREADY-SUBMITTED STOCK ENTRY (within the edit window)
  // ============================================================
  const handleOpenEditStockEntry = (entry) => {
    setEditingStockEntry(entry);
    // Work from a deep-ish copy with number fields as editable strings,
    // same convention the rest of the form inputs use.
    setEditStockItems(
      entry.items.map((item) => ({
        ...item,
        quantity: String(item.quantity ?? ''),
        costPrice: String(item.costPrice ?? ''),
        retailPrice: item.retailPrice !== undefined && item.retailPrice !== null
          ? String(item.retailPrice)
          : '',
        wholesalePrice: item.wholesalePrice !== undefined && item.wholesalePrice !== null
          ? String(item.wholesalePrice)
          : '',
        halfPackQty: item.halfPackQty ?? '',
        halfPackPrice: item.halfPackPrice ?? '',
        packQty: item.packQty ?? '',
        packPrice: item.packPrice ?? ''
      }))
    );
  };

  const updateEditStockItem = (index, field, value) => {
    setEditStockItems((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: value } : item))
    );
  };

  // Dropping a line during an edit is allowed (it just won't be in
  // newItems, same as editStockEntry's own doc comment describes) —
  // adding a brand-new line isn't, since that's really a new delivery.
  const removeEditStockItem = (index) => {
    setEditStockItems((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSaveStockEdit = async () => {
    if (!editingStockEntry) return;

    if (editStockItems.length === 0) {
      alert('An entry needs at least one line — remove the whole entry instead if none of this is right.');
      return;
    }

    setIsSavingStockEdit(true);
    try {
      const optionalNumber = (value) =>
        value === '' || value === null || value === undefined ? null : Number(value);

      const newItems = editStockItems.map((item) => ({
        drugId: item.drugId,
        isNewDrug: item.isNewDrug,
        name: item.name,
        unitType: item.unitType,
        quantity: Number(item.quantity) || 0,
        costPrice: Number(item.costPrice) || 0,
        retailPrice: item.retailPrice === '' ? undefined : Number(item.retailPrice) || 0,
        wholesalePrice: item.wholesalePrice === '' ? undefined : Number(item.wholesalePrice) || 0,
        barcode: item.isNewDrug ? item.barcode || '' : undefined,
        halfPackQty: item.isNewDrug ? optionalNumber(item.halfPackQty) : undefined,
        halfPackPrice: item.isNewDrug ? optionalNumber(item.halfPackPrice) : undefined,
        packQty: item.isNewDrug ? optionalNumber(item.packQty) : undefined,
        packPrice: item.isNewDrug ? optionalNumber(item.packPrice) : undefined
      }));

      const result = await editStockEntry(editingStockEntry, newItems, {
        id: session?.user?.id,
        email: session?.user?.email,
        role: userRole
      });

      if (result.success) {
        alert(
          result.pending
            ? "Sent to a manager for approval — the entry won't change until then."
            : 'Stock entry updated.'
        );
        setEditingStockEntry(null);
        setEditStockItems([]);
      } else {
        alert(result.reason || 'Unable to save these changes.');
      }
    } finally {
      setIsSavingStockEdit(false);
    }
  };

  const handleApproveStockEdit = async (editRequest) => {
    if (
      !window.confirm(
        `Approve this correction to the stock entry from ${nameOf(editRequest.requestedByEmail)}? Stock will update immediately.`
      )
    ) {
      return;
    }

    const result = await approveStockEntryEdit(editRequest, {
      email: session?.user?.email,
      role: userRole
    });

    if (!result.success) {
      alert(result.reason || 'Unable to approve this edit.');
    }
  };

  const handleOpenRejectStockEdit = (editRequest) => {
    setRejectingStockEdit(editRequest);
    setStockEditRejectReason('');
  };

  const handleConfirmRejectStockEdit = async () => {
    if (!rejectingStockEdit) return;
    if (!stockEditRejectReason.trim()) {
      alert('Enter a short reason so the person who requested it knows why.');
      return;
    }

    setIsRejectingStockEdit(true);
    try {
      const result = await rejectStockEntryEdit(
        rejectingStockEdit,
        stockEditRejectReason,
        { email: session?.user?.email, role: userRole }
      );
      if (result.success) {
        setRejectingStockEdit(null);
        setStockEditRejectReason('');
      } else {
        alert(result.reason || 'Unable to reject this edit.');
      }
    } finally {
      setIsRejectingStockEdit(false);
    }
  };

  // ============================================================
  // MANAGER: APPROVE/REJECT A DRUG OR SUPPLIER CHANGE REQUEST
  // (a cashier's edit/delete of a drug or supplier, queued for sign-off)
  // ============================================================
  const handleApproveChangeRequest = async (kind, request) => {
    setIsApprovingChangeRequestId(request.id);
    try {
      const actor = { email: session?.user?.email, role: userRole };
      const result =
        kind === 'drug'
          ? await approveDrugChangeRequest(request, actor)
          : kind === 'customer'
          ? await approveCustomerChangeRequest(request, actor)
          : await approveSupplierChangeRequest(request, actor);
      if (!result.success) {
        alert(result.reason || 'Unable to approve this request.');
      }
    } finally {
      setIsApprovingChangeRequestId(null);
    }
  };

  const handleOpenRejectChangeRequest = (kind, request) => {
    setRejectingChangeRequest({ kind, request });
    setChangeRequestRejectReason('');
  };

  const handleConfirmRejectChangeRequest = async () => {
    if (!rejectingChangeRequest) return;
    if (!changeRequestRejectReason.trim()) {
      alert('Enter a short reason so the person who requested it knows why.');
      return;
    }
    setIsRejectingChangeRequest(true);
    try {
      const actor = { email: session?.user?.email, role: userRole };
      const { kind, request } = rejectingChangeRequest;
      const result =
        kind === 'drug'
          ? await rejectDrugChangeRequest(request, changeRequestRejectReason, actor)
          : kind === 'customer'
          ? await rejectCustomerChangeRequest(request, changeRequestRejectReason, actor)
          : await rejectSupplierChangeRequest(request, changeRequestRejectReason, actor);
      if (result.success) {
        setRejectingChangeRequest(null);
        setChangeRequestRejectReason('');
      } else {
        alert(result.reason || 'Unable to reject this request.');
      }
    } finally {
      setIsRejectingChangeRequest(false);
    }
  };

  // ============================================================
  // ADMIN: BANK OPTIONS
  // ============================================================
  // ============================================================
  // PRICING SETTINGS (admin-editable general recommended profit %)
  // ============================================================
  const handleSavePricingSettings = async () => {
    setIsSavingPricingSettings(true);
    try {
      const parsed = {
        wholesalePercent: Number(pricingSettingsForm.wholesalePercent),
        retailPercent: Number(pricingSettingsForm.retailPercent),
        highValueThreshold: Number(pricingSettingsForm.highValueThreshold),
        highValuePercent: Number(pricingSettingsForm.highValuePercent),
        highValueMinPercent: Number(pricingSettingsForm.highValueMinPercent),
        highValueMaxPercent: Number(pricingSettingsForm.highValueMaxPercent)
      };
      if (Object.values(parsed).some((n) => !Number.isFinite(n) || n < 0)) {
        alert('Every field needs a valid, non-negative number.');
        return;
      }
      if (parsed.highValueMinPercent > parsed.highValueMaxPercent) {
        alert('The high-value minimum % can\'t be more than the maximum %.');
        return;
      }
      const result = await savePricingSettings(parsed, {
        email: session?.user?.email,
        role: userRole
      });
      if (result.success) {
        setPricingSettings(result.settings);
        setPricingSettingsForm(result.settings);
      } else {
        alert(`Couldn't save pricing settings: ${result.reason}`);
      }
    } finally {
      setIsSavingPricingSettings(false);
    }
  };

  // ============================================================
  // CSV / EXCEL DRUG IMPORT & EXPORT
  // ============================================================
  const DRUG_EXPORT_COLUMNS = [
    'name', 'unitType', 'costPrice', 'retailPrice', 'wholesalePrice',
    'stock', 'barcode', 'minStockQty', 'recommendedPurchaseQty',
    'halfPackQty', 'halfPackPrice', 'packQty', 'packPrice', 'counterSpace'
  ];

  const handleExportDrugs = async (format) => {
    const XLSX = await import('xlsx');
    const rows = (allActiveDrugsForCrud || []).map((d) => {
      const row = {};
      DRUG_EXPORT_COLUMNS.forEach((col) => {
        row[col] = d[col] ?? '';
      });
      return row;
    });
    const worksheet = XLSX.utils.json_to_sheet(rows, { header: DRUG_EXPORT_COLUMNS });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Drugs');
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, `azu-drugs-${stamp}.${format === 'csv' ? 'csv' : 'xlsx'}`, {
      bookType: format === 'csv' ? 'csv' : 'xlsx'
    });
  };

  const handleDrugImportFileChosen = async (file) => {
    if (!file) return;
    setImportFileName(file.name);
    setImportResultSummary(null);
    try {
      const XLSX = await import('xlsx');
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[firstSheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      setImportPreviewRows(rows);
    } catch (err) {
      alert(`Couldn't read that file: ${err.message}`);
      setImportPreviewRows(null);
      setImportFileName('');
    }
  };

  const handleConfirmDrugImport = async () => {
    if (!importPreviewRows || importPreviewRows.length === 0) return;
    setIsImportingDrugs(true);
    try {
      const result = await bulkImportDrugs(importPreviewRows, {
        email: session?.user?.email,
        role: userRole
      });
      setImportResultSummary(result);
      if (result.success) {
        setImportPreviewRows(null);
        setImportFileName('');
      }
    } finally {
      setIsImportingDrugs(false);
    }
  };

  const handleCancelDrugImport = () => {
    setImportPreviewRows(null);
    setImportFileName('');
    setImportResultSummary(null);
  };

  // ============================================================
  // DATA HUB — download (and where it's safe, upload) every dataset
  // ============================================================
  const flattenForExport = (row) => {
    const out = {};
    Object.entries(row || {}).forEach(([k, v]) => {
      if (k === 'synced' || k === 'reversalPending' || k === 'balanceDirty') return;
      if (v === null || v === undefined) out[k] = '';
      else if (typeof v === 'object') out[k] = JSON.stringify(v);
      else out[k] = v;
    });
    return out;
  };

  const humanItemsSummary = (items) =>
    (Array.isArray(items) ? items : [])
      .map((i) => `${i.name} x${i.quantity}${i.reversedQty ? ` (returned ${i.reversedQty})` : ''}`)
      .join('; ');

  const DATA_HUB_DATASETS = [
    {
      key: 'suppliers',
      label: 'Suppliers',
      help: 'Columns: name, contactPerson, phone, email, address. Matches existing suppliers by name.',
      importFn: bulkImportSuppliers,
      getRows: async () =>
        (await db.suppliers.toArray())
          .filter((r) => !r.deletedAt)
          .map((r) => ({
            name: r.name,
            contactPerson: r.contactPerson || '',
            phone: r.phone || '',
            email: r.email || '',
            address: r.address || ''
          }))
    },
    {
      key: 'customers',
      label: 'Wholesale Customers',
      help: 'Columns: name, phones (separate several with ; ), email, address, balance. Matches by name. "balance" is only used for brand-new customers (opening balance) — existing balances are never changed by an import.',
      importFn: bulkImportCustomers,
      getRows: async () =>
        (await db.customers.toArray())
          .filter((r) => !r.deletedAt)
          .map((r) => ({
            name: r.name,
            phones: (r.phones && r.phones.length ? r.phones : r.phone ? [r.phone] : []).join('; '),
            email: r.email || '',
            address: r.address || '',
            balance: Number(r.balance || 0)
          }))
    },
    {
      key: 'banks',
      label: 'Bank Options',
      adminOnly: true,
      help: 'Columns: name, color. Existing names are skipped.',
      importFn: bulkImportBankOptions,
      getRows: async () =>
        (await db.bankOptions.toArray()).map((r) => ({
          name: r.name,
          color: r.color || '',
          active: r.active === false ? 'no' : 'yes'
        }))
    },
    {
      key: 'sales',
      label: 'Sales (one row per sale)',
      exportOnly: true,
      help: 'Every sale you can see, with full names for attendant and cashier. Export only — sales can\'t be imported, so history can\'t be altered.',
      getRows: async () =>
        (allSalesForSearch || []).map((s) => ({
          saleId: s.id,
          date: s.createdAt,
          saleType: s.saleType,
          attendant: nameOf(s.attendantEmail) || '',
          cashier: nameOf(s.cashierEmail) || '',
          customer: s.customerName || '',
          customerPhone: s.customerPhone || '',
          total: s.total,
          amountPaid: s.amountPaid ?? '',
          customerBalanceAfter: s.customerBalanceAfter ?? '',
          items: humanItemsSummary(s.items)
        }))
    },
    {
      key: 'saleItems',
      label: 'Sale Items (one row per item sold)',
      exportOnly: true,
      help: 'Each drug line of each sale, including how many were returned.',
      getRows: async () =>
        (allSalesForSearch || []).flatMap((s) =>
          (Array.isArray(s.items) ? s.items : []).map((i) => ({
            saleId: s.id,
            date: s.createdAt,
            cashier: nameOf(s.cashierEmail) || '',
            drug: i.name,
            quantity: i.quantity,
            returnedQty: i.reversedQty || 0,
            unitPrice: i.activePrice ?? '',
            lineTotal: i.lineTotal ?? ''
          }))
        )
    },
    {
      key: 'stockEntries',
      label: 'Stock Entries (restocking)',
      exportOnly: true,
      help: 'Every restock entry with who entered it.',
      getRows: async () =>
        (await db.stockEntries.toArray()).map((r) =>
          flattenForExport({ ...r, enteredBy: nameOf(r.enteredByEmail) })
        )
    },
    {
      key: 'tickets',
      label: 'Tickets',
      exportOnly: true,
      help: 'All tickets stored on this device (last 2 days are kept in sync).',
      getRows: async () =>
        (await db.tickets.toArray()).map((r) =>
          flattenForExport({
            ...r,
            attendant: nameOf(r.attendantEmail),
            cashier: nameOf(r.cashierEmail),
            items: humanItemsSummary(r.items)
          })
        )
    },
    {
      key: 'reversals',
      label: 'Reversal Requests',
      exportOnly: true,
      help: 'Return / reversal requests and their outcome.',
      getRows: async () =>
        (await db.reversalRequests.toArray()).map((r) =>
          flattenForExport({ ...r, requestedBy: nameOf(r.requestedByEmail), decidedBy: nameOf(r.decidedByEmail) })
        )
    },
    {
      key: 'purchaseLists',
      label: 'Purchase Lists',
      exportOnly: true,
      help: 'Saved purchase lists.',
      getRows: async () =>
        (await db.purchaseLists.toArray()).map((r) =>
          flattenForExport({ ...r, createdBy: nameOf(r.createdByEmail) })
        )
    },
    {
      key: 'audit',
      label: 'Audit Log',
      exportOnly: true,
      adminOnly: true,
      help: 'The full audit trail stored on this device.',
      getRows: async () =>
        (await db.auditLog.toArray()).map((r) =>
          flattenForExport({ ...r, actor: nameOf(r.actorEmail) })
        )
    },
    {
      key: 'accounts',
      label: 'Accounts',
      exportOnly: true,
      adminOnly: true,
      help: 'Names, emails, roles and status (no passwords — those are never readable).',
      getRows: async () => {
        const res = await fetchAllProfiles();
        return (res.success ? res.profiles : []).map((p) => ({
          fullName: p.full_name || '',
          email: p.email || '',
          role: p.role,
          active: p.is_active === false ? 'no' : 'yes'
        }));
      }
    }
  ];

  const activeHubDataset =
    DATA_HUB_DATASETS.find((d) => d.key === hubDatasetKey) || DATA_HUB_DATASETS[0];

  const handleHubExport = async (format) => {
    setIsHubBusy(true);
    try {
      const rows = await activeHubDataset.getRows();
      if (!rows || rows.length === 0) {
        alert('There is nothing to export for this dataset yet.');
        return;
      }
      const XLSX = await import('xlsx');
      const worksheet = XLSX.utils.json_to_sheet(rows);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, activeHubDataset.label.slice(0, 28));
      const stamp = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(workbook, `azu-${activeHubDataset.key}-${stamp}.${format === 'csv' ? 'csv' : 'xlsx'}`, {
        bookType: format === 'csv' ? 'csv' : 'xlsx'
      });
    } catch (err) {
      alert(`Export failed: ${err.message}`);
    } finally {
      setIsHubBusy(false);
    }
  };

  const handleHubFileChosen = async (file) => {
    if (!file) return;
    setHubFileName(file.name);
    setHubResult(null);
    try {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      setHubPreviewRows(XLSX.utils.sheet_to_json(sheet, { defval: '' }));
    } catch (err) {
      alert(`Couldn't read that file: ${err.message}`);
      setHubPreviewRows(null);
    }
  };

  const handleHubConfirmImport = async () => {
    if (!hubPreviewRows || !activeHubDataset.importFn) return;
    setIsHubBusy(true);
    try {
      const result = await activeHubDataset.importFn(hubPreviewRows, {
        id: session?.user?.id,
        email: session?.user?.email,
        role: userRole
      });
      setHubResult(result);
      if (result.success) {
        setHubPreviewRows(null);
        setHubFileName('');
      }
    } finally {
      setIsHubBusy(false);
    }
  };

  // ============================================================
  // ROLE MANAGEMENT (administrator-only)
  // ============================================================
  const handleLoadProfiles = async () => {
    setIsLoadingProfiles(true);
    try {
      const result = await fetchAllProfiles();
      if (result.success) {
        setAllProfiles(result.profiles);
      } else {
        alert(`Couldn't load accounts: ${result.reason}`);
      }
    } finally {
      setIsLoadingProfiles(false);
    }
  };

  const handleChangeUserRole = async (profile, newRole) => {
    if (newRole === profile.role) return;
    if (profile.role === 'administrator' || newRole === 'administrator') {
      alert(
        "Administrator roles can only be changed directly in Supabase — not from this panel."
      );
      return;
    }
    if (
      !window.confirm(
        `Change ${profile.full_name || profile.email || profile.id}'s role from "${profile.role}" to "${newRole}"?`
      )
    ) {
      return;
    }
    setSavingProfileId(profile.id);
    try {
      const result = await updateUserRole(profile.id, newRole, {
        email: session?.user?.email,
        role: userRole
      });
      if (result.success) {
        setAllProfiles((prev) =>
          (prev || []).map((p) => (p.id === profile.id ? { ...p, role: newRole } : p))
        );
      } else {
        alert(`Couldn't change that role: ${result.reason}`);
      }
    } finally {
      setSavingProfileId(null);
    }
  };

  const adminActor = () => ({
    id: session?.user?.id,
    email: session?.user?.email,
    role: userRole
  });

  const refreshAccountLists = async () => {
    await handleLoadProfiles();
    const rows = await fetchProfileDirectory();
    if (rows) setProfileDirectory(rows);
  };

  const handleOpenCreateAccount = () => {
    setAccountForm({ email: '', fullName: '', password: '', role: 'salesperson' });
    setAccountModal({ mode: 'create' });
  };

  const handleOpenEditAccount = (profile) => {
    setAccountForm({
      email: profile.email || '',
      fullName: profile.full_name || '',
      password: '',
      role: profile.role
    });
    setAccountModal({ mode: 'edit', profile });
  };

  const handleOpenSetPassword = (profile) => {
    setAccountForm({ email: '', fullName: '', password: '', role: profile.role });
    setAccountModal({ mode: 'password', profile });
  };

  const handleSubmitAccountModal = async (e) => {
    e.preventDefault();
    if (!accountModal) return;
    setIsSavingAccount(true);
    try {
      let result;
      if (accountModal.mode === 'create') {
        result = await createAccount(
          {
            email: accountForm.email,
            fullName: accountForm.fullName,
            password: accountForm.password,
            role: accountForm.role
          },
          adminActor()
        );
        if (result.success) {
          alert(
            `Account created.\n\nEmail: ${accountForm.email.trim().toLowerCase()}\nPassword: ${accountForm.password}\n\nGive these to ${accountForm.fullName.trim()} — if they ever forget it, they can use “Forgot your password?” on the sign-in page, or you can set a new one here.`
          );
        }
      } else if (accountModal.mode === 'edit') {
        const target = accountModal.profile;
        const emailChanged =
          accountForm.email.trim().toLowerCase() !== (target.email || '').toLowerCase();
        if (
          emailChanged &&
          !window.confirm(
            `Change the login email from ${target.email} to ${accountForm.email.trim()}?\n\nAll of ${target.full_name || 'this person'}'s past sales and approvals stay linked to them.`
          )
        ) {
          setIsSavingAccount(false);
          return;
        }
        result = await updateAccountDetails(
          target.id,
          {
            fullName: accountForm.fullName,
            email: accountForm.email,
            role: accountForm.role
          },
          adminActor()
        );
      } else {
        result = await setAccountPassword(
          accountModal.profile.id,
          accountForm.password,
          adminActor()
        );
        if (result.success) {
          alert(
            `Password changed for ${accountModal.profile.full_name || accountModal.profile.email}.\n\nNew password: ${accountForm.password}\n\nGive it to them.`
          );
        }
      }

      if (result.success) {
        setAccountModal(null);
        await refreshAccountLists();
      } else {
        alert(result.reason || 'That did not work.');
      }
    } finally {
      setIsSavingAccount(false);
    }
  };

  const handleToggleAccountActive = async (profile) => {
    const makeActive = profile.is_active === false;
    if (
      !window.confirm(
        makeActive
          ? `Re-activate ${profile.full_name || profile.email}? They will be able to sign in again.`
          : `Deactivate ${profile.full_name || profile.email}? They won't be able to sign in, but all their past records stay.`
      )
    ) {
      return;
    }
    setSavingProfileId(profile.id);
    try {
      const result = await setAccountActive(profile.id, makeActive, adminActor());
      if (result.success) await refreshAccountLists();
      else alert(result.reason || 'Could not change that account.');
    } finally {
      setSavingProfileId(null);
    }
  };

  const generateTemporaryPassword = () => {
    const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = new Uint32Array(10);
    crypto.getRandomValues(bytes);
    const pw = Array.from(bytes, (n) => chars[n % chars.length]).join('');
    setAccountForm((f) => ({ ...f, password: pw }));
  };

  const handleAddBankOption = async () => {
    const name = newBankOptionName.trim();
    if (!name) return;

    await addBankOption(
      name,
      { email: session?.user?.email, role: userRole },
      newBankOptionColor
    );

    setNewBankOptionName('');
    setNewBankOptionColor('#6b7280');
  };

  const handleRemoveBankOption = async (option) => {
    if (!window.confirm(`Remove "${option.name}" from the bank list?`)) return;

    await removeBankOption(option.id, {
      email: session?.user?.email,
      role: userRole
    });
  };

  const handleChangeBankOptionColor = async (option, color) => {
    await updateBankOption(
      option.id,
      { color },
      { email: session?.user?.email, role: userRole }
    );
  };

  // ============================================================
  // CHECKOUT
  // The receipt now shows as soon as the LOCAL write succeeds.
  // Everything that talks to Supabase runs afterwards, in the
  // background, via syncSaleToCloud — it no longer blocks the UI.
  // ============================================================
  const handleCheckout = async () => {
    if (cart.length === 0) return;

    try {
      const saleId = `REC-${Date.now()}`;

      const saleData = {
        id: saleId,
        total: cartTotal,
        saleType,
        cashierId:
          session?.user?.id || 'offline_id',
        cashierEmail:
          session?.user?.email ||
          'offline_cashier',
        customerName:
          customerName.trim() ||
          'Walk-in Customer',
        customerPhone:
          customerPhone.trim() || 'N/A',
        createdAt: new Date().toISOString(),
        items: slimCartItems(cart),
        synced: 0
      };

      await db.transaction(
        'rw',
        db.drugs,
        db.sales,
        async () => {
          for (const item of cart) {
            if (item.id) {
              const drugKey = String(item.id);

              const existingDrug =
                (await db.drugs.get(drugKey)) ||
                (await db.drugs.get(
                  Number(item.id)
                ));

              if (existingDrug) {
                // Stock is never allowed to go negative — clamp at 0.
                const newStock = Math.max(
                  0,
                  (existingDrug.stock || 0) - item.quantity
                );

                await db.drugs.update(
                  existingDrug.id,
                  {
                    stock: newStock,
                    synced: 0
                  }
                );
              }
            }
          }

          await db.sales.add(saleData);
        }
      );

      // The sale is now safely on the device — show the receipt
      // immediately instead of waiting on any network call.
      setSaleSuccessData(saleData);
      setShowReceiptModal(true);

      setCart([]);
      setCustomerName('');
      setCustomerPhone('');

      if (isOnline) {
        syncSaleToCloud(saleData).catch((err) => {
          console.warn('Background sale sync failed:', err.message);
        });
      }
    } catch (err) {
      console.error(
        'Checkout error:',
        err
      );

      alert(
        `Checkout failed: ${
          err.message ||
          'Error processing database transaction'
        }`
      );
    }
  };

  // Runs in the background after the receipt is already on screen.
  // Per-item stock updates go out in parallel (Promise.all) instead
  // of one at a time, and the new sale is folded straight into
  // cloudSales instead of re-fetching the entire sales history.
  const syncSaleToCloud = async (saleData) => {
    const stockUpdates = saleData.items
      .filter((item) => item.id)
      .map(async (item) => {
        const drugKey = String(item.id);

        const updatedDrug =
          (await db.drugs.get(drugKey)) ||
          (await db.drugs.get(Number(item.id)));

        if (!updatedDrug) return;

        try {
          await pushDrugStockDelta(
            updatedDrug.id,
            -Number(item.quantity),
            updatedDrug.stock
          );
        } catch (cloudErr) {
          console.warn(
            `Stock update postponed for ${item.name}:`,
            cloudErr.message
          );
        }
      });

    await Promise.all(stockUpdates);

    const supabasePayload = {
      id: saleData.id,
      total: saleData.total,
      sale_type: saleData.saleType,
      cashier_id: saleData.cashierId,
      cashier_email: saleData.cashierEmail,
      customer_name: saleData.customerName,
      customer_phone: saleData.customerPhone,
      created_at: saleData.createdAt,
      items: JSON.stringify(saleData.items)
    };

    const { error } = await supabase
      .from('sales')
      .insert([supabasePayload]);

    if (!error) {
      await db.sales.update(saleData.id, { synced: 1 });
      setCloudSales((prev) => [{ ...saleData, synced: 1 }, ...prev]);
    } else {
      console.warn(
        'Cloud insert pending, queued locally:',
        error.message
      );
    }
  };

  // ============================================================
  // MANAGER CRUD
  // ============================================================
  const handleOpenAddModal = () => {
    setEditingDrug(null);

    setFormData({
      name: '',
      unitType: 'Unit',
      costPrice: '',
      retailPrice: '',
      wholesalePrice: '',
      stock: '',
      barcode: '',
      halfPackQty: '',
      halfPackPrice: '',
      packQty: '',
      packPrice: '',
      minStockQty: '',
      recommendedPurchaseQty: '',
      counterSpace: ''
    });

    setIsModalOpen(true);
  };

  const handleOpenEditModal = (drug, e) => {
    if (e) e.stopPropagation();

    setEditingDrug(drug);

    setFormData({
      name: drug.name || '',
      unitType:
        drug.unitType ||
        drug.unit_type ||
        'Sachet',
      costPrice:
        drug.costPrice ??
        drug.cost_price ??
        '',
      retailPrice:
        drug.retailPrice ??
        drug.retail_price ??
        '',
      wholesalePrice:
        drug.wholesalePrice ??
        drug.wholesale_price ??
        '',
      stock: drug.stock ?? '',
      barcode: drug.barcode || '',
      halfPackQty:
        drug.halfPackQty ??
        drug.half_pack_qty ??
        '',
      halfPackPrice:
        drug.halfPackPrice ??
        drug.half_pack_price ??
        '',
      packQty:
        drug.packQty ??
        drug.pack_qty ??
        '',
      packPrice:
        drug.packPrice ??
        drug.pack_price ??
        '',
      minStockQty:
        drug.minStockQty ??
        drug.min_stock_qty ??
        '',
      recommendedPurchaseQty:
        drug.recommendedPurchaseQty ??
        drug.recommended_purchase_qty ??
        '',
      counterSpace: drug.counterSpace ?? drug.counter_space ?? ''
    });

    setIsModalOpen(true);
  };

  // A manager's delete is now a SOFT delete — the drug moves to the
  // administrator's "Recently Deleted" list instead of disappearing
  // for good. Only an administrator can remove it permanently. This is
  // now called only after the unmissable confirm-delete modal confirms
  // (see confirmDeleteTarget), and for a cashier it goes through
  // requestDeleteDrug so it needs a manager's approval first instead of
  // disappearing immediately.
  const handleDeleteDrug = async (id, e) => {
    if (e) e.stopPropagation();
    const drug = drugs.find((d) => String(d.id) === String(id));
    if (!drug) return;
    setDeletingTarget({ kind: 'drug', item: drug });
  };

  // Called by the confirm-delete modal's "Delete" button, for a target
  // of kind 'drug'. Soft-deletes directly for a manager/administrator;
  // for a cashier, queues it as a pending drugChangeRequests row instead.
  const handleConfirmDeleteDrug = async (drug) => {
    const actor = { email: session?.user?.email, role: userRole };
    const result = await requestDeleteDrug(drug, actor);
    if (!result.success) {
      alert(result.reason || 'Unable to delete this drug.');
      return;
    }
    if (result.pending) {
      alert(
        `"${drug.name}" won't be deleted until a manager approves it — it's been sent to them for review.`
      );
    }
  };

  // Pushes a saved drug to Supabase in the background, after the modal
  // has already closed. If the cloud rejects it — most likely the
  // drugs_name_key unique constraint firing because another device
  // just saved the same name, or because a soft-deleted drug still
  // holds that name — the local copy this device just created is
  // rolled back, so it can't keep sitting there as a phantom the cloud
  // never accepted. This is the piece that was missing before: a
  // failed cloud upsert used to leave the local row untouched forever.
  const syncDrugToCloud = async (drugId, drugPayload, wasEditing) => {
    const cloudPayload = {
      id: drugId,
      name: drugPayload.name,
      unit_type: drugPayload.unitType,
      cost_price: drugPayload.costPrice,
      retail_price: drugPayload.retailPrice,
      wholesale_price: drugPayload.wholesalePrice,
      stock: drugPayload.stock,
      barcode: drugPayload.barcode,
      half_pack_qty: drugPayload.halfPackQty,
      half_pack_price: drugPayload.halfPackPrice,
      pack_qty: drugPayload.packQty,
      pack_price: drugPayload.packPrice,
      min_stock_qty: drugPayload.minStockQty ?? null,
      recommended_purchase_qty: drugPayload.recommendedPurchaseQty ?? null,
      counter_space: drugPayload.counterSpace ?? ''
    };

    let { error: upsertError } = await supabase
      .from('drugs')
      .upsert([cloudPayload]);

    // Migration v18 not run yet -> counter_space column is missing; save
    // the rest rather than rejecting the whole drug.
    if (upsertError && /counter_space/i.test(upsertError.message || '')) {
      const { counter_space, ...withoutCounter } = cloudPayload;
      ({ error: upsertError } = await supabase
        .from('drugs')
        .upsert([withoutCounter]));
    }

    if (upsertError) {
      console.error('Cloud save failed:', upsertError.message);

      const isDuplicateName =
        upsertError.code === '23505' ||
        /duplicate key/i.test(upsertError.message || '');

      if (isDuplicateName && !wasEditing) {
        await db.drugs.delete(drugId);
        alert(
          `"${drugPayload.name}" already exists in the shared catalog (it may have just been added from another device, or a deleted drug still holds that name). The local copy on this device has been removed — refresh to see the current catalog.`
        );
      } else {
        alert(
          `Warning: saved on this device, but the cloud update failed (${upsertError.message}). This will keep retrying automatically — on this device or any other that's online — until it syncs.`
        );
      }
    } else {
      await db.drugs.update(drugId, { synced: 1 });
    }
  };

  const handleSaveDrug = async (e) => {
    e.preventDefault();

    // Synchronous guard: if a save is already in flight, a second,
    // near-instant click (or a double-click) is ignored outright,
    // before it can create a second local row with a different id.
    if (isSavingDrugRef.current) return;
    isSavingDrugRef.current = true;
    setIsSavingDrug(true);

    try {
      const trimmedName = formData.name.trim();

      // Enforce "no two drugs share a name" locally, before writing
      // anything — this is what actually stops duplicates from being
      // created, rather than only finding out after the fact when
      // Supabase's unique constraint rejects the cloud write.
      const nameMatches = await db.drugs
        .where('name')
        .equalsIgnoreCase(trimmedName)
        .toArray();

      const conflict = nameMatches.find(
        (d) => !editingDrug || String(d.id) !== String(editingDrug.id)
      );

      if (conflict) {
        if (conflict.deletedAt) {
          alert(
            `A drug named "${trimmedName}" already exists but was deleted. Ask an administrator to restore it from Admin → Recently Deleted instead of creating a new one with the same name.`
          );
        } else {
          alert(`A drug named "${trimmedName}" already exists.`);
        }
        return; // modal stays open so the name can be corrected
      }

      const drugId = editingDrug
        ? String(editingDrug.id)
        : Date.now().toString();

      // Pack/half-pack fields are optional — a blank slot means "this
      // drug has no discounted pack pricing", stored as null rather
      // than 0 so it's never mistaken for a free/zero-priced pack.
      const optionalNumber = (value) =>
        value === '' || value === null || value === undefined
          ? null
          : Number(value);

      const drugPayload = {
        id: drugId,
        name: trimmedName,
        unitType: formData.unitType,
        costPrice: Number(formData.costPrice),
        retailPrice: Number(formData.retailPrice),
        wholesalePrice: Number(formData.wholesalePrice),
        stock: Math.max(0, Number(formData.stock) || 0),
        barcode: formData.barcode,
        halfPackQty: optionalNumber(formData.halfPackQty),
        halfPackPrice: optionalNumber(formData.halfPackPrice),
        packQty: optionalNumber(formData.packQty),
        packPrice: optionalNumber(formData.packPrice),
        minStockQty: optionalNumber(formData.minStockQty),
        recommendedPurchaseQty: optionalNumber(formData.recommendedPurchaseQty),
        counterSpace: String(formData.counterSpace || '').trim(),
        synced: 0
      };

      const wasEditing = Boolean(editingDrug);
      const isCashierEditing = wasEditing && userRole === 'cashier';

      // A cashier editing an EXISTING drug needs a manager's approval —
      // same cashier-needs-approval shape as suppliers, stock entries,
      // etc. Nothing in the catalog changes until it's approved.
      // Creating a brand-new drug stays unrestricted for either role.
      if (isCashierEditing) {
        const { synced, id, ...changes } = drugPayload;
        const result = await requestDrugEdit(
          editingDrug,
          changes,
          { email: session?.user?.email, role: userRole }
        );
        setIsModalOpen(false);
        if (!result.success) {
          alert(result.reason || 'Unable to submit this edit.');
        } else if (result.pending) {
          alert(
            `Your changes to "${trimmedName}" have been sent to a manager for approval — nothing in the catalog has changed yet.`
          );
        }
        return;
      }

      if (editingDrug) {
        await db.drugs.update(editingDrug.id, drugPayload);
      } else {
        await db.drugs.add(drugPayload);
      }

      // Learn from this choice for next time's recommendation on this
      // same drug — fire-and-forget, never blocks closing the form.
      recordDrugPriceChoice(
        drugId,
        drugPayload.costPrice,
        drugPayload.retailPrice,
        drugPayload.wholesalePrice
      ).catch((err) => console.warn('Price-history record failed:', err.message));

      // The local write is done — close the form immediately instead
      // of making the user wait on the network. This also removes the
      // Save button from the screen, so there's nothing left to
      // double-click even if someone tries.
      setIsModalOpen(false);

      if (isOnline) {
        syncDrugToCloud(drugId, drugPayload, wasEditing).catch((err) => {
          console.warn('Background drug sync failed:', err.message);
        });
      }

      logAuditEvent({
        actorEmail: session?.user?.email,
        actorRole: userRole,
        action: wasEditing ? 'drug_updated' : 'drug_added',
        targetType: 'drug',
        targetId: drugId,
        details: { name: trimmedName }
      }).catch((err) => {
        console.warn('Audit log failed:', err.message);
      });
    } finally {
      isSavingDrugRef.current = false;
      setIsSavingDrug(false);
    }
  };

  // ============================================================
  // ADMINISTRATOR ACTIONS
  // ============================================================
  const handleRestoreDrug = async (id) => {
    await restoreDrug(id, {
      email: session?.user?.email,
      role: userRole
    });
  };

  const handlePermanentDelete = async (id, name) => {
    if (
      window.confirm(
        `Permanently delete "${name}"? This cannot be undone.`
      )
    ) {
      await permanentlyDeleteDrug(id, {
        email: session?.user?.email,
        role: userRole
      });
    }
  };

  const handleRestoreCustomer = async (id) => {
    await restoreCustomer(id, {
      email: session?.user?.email,
      role: userRole
    });
  };

  const handlePermanentDeleteCustomer = async (id, name) => {
    if (
      window.confirm(
        `Permanently delete "${name}"? This cannot be undone.`
      )
    ) {
      await permanentlyDeleteCustomer(id, {
        email: session?.user?.email,
        role: userRole
      });
    }
  };

  const handleRestoreSupplier = async (id) => {
    await restoreSupplier(id, {
      email: session?.user?.email,
      role: userRole
    });
  };

  const handlePermanentDeleteSupplier = async (id, name) => {
    if (
      window.confirm(
        `Permanently delete "${name}"? This cannot be undone.`
      )
    ) {
      await permanentlyDeleteSupplier(id, {
        email: session?.user?.email,
        role: userRole
      });
    }
  };

  const handleBulkDeleteSales = async () => {
    if (!bulkDeleteStart || !bulkDeleteEnd) {
      alert('Choose a start and end date first.');
      return;
    }

    const confirmed = window.confirm(
      `Permanently delete ALL sales between ${bulkDeleteStart} and ${bulkDeleteEnd}? This cannot be undone.`
    );

    if (!confirmed) return;

    const count = await bulkDeleteSalesByDateRange(
      `${bulkDeleteStart}T00:00:00.000Z`,
      `${bulkDeleteEnd}T23:59:59.999Z`,
      { email: session?.user?.email, role: userRole }
    );

    alert(`Deleted ${count} sale record(s) from ${bulkDeleteStart} to ${bulkDeleteEnd}.`);

    setBulkDeleteStart('');
    setBulkDeleteEnd('');

    fetchCloudSales();
  };

  // ============================================================
  // LOGIN SCREEN
  // ============================================================
  if (session && isRecoveringPassword) {
    return (
      <div className="login-container">
        <div className="login-card">
          <h2>CHOOSE A NEW PASSWORD</h2>
          <p>Signed in as {session.user.email}</p>

          {authError && <div className="auth-error">{authError}</div>}

          <form onSubmit={handleSaveNewPassword}>
            <label>New password:</label>
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />

            <label>Confirm new password:</label>
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={confirmNewPassword}
              onChange={(e) => setConfirmNewPassword(e.target.value)}
            />

            <button type="submit" className="login-btn" disabled={isSavingPassword}>
              {isSavingPassword ? 'Saving…' : 'Save Password'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (!session) {
    if (authView === 'forgot') {
      return (
        <div className="login-container">
          <div className="login-card">
            <h2>RESET PASSWORD</h2>
            <p>
              Enter your account email and we'll send you a link to choose a
              new password.
            </p>

            {authError && <div className="auth-error">{authError}</div>}
            {authInfo && <div className="auth-info">{authInfo}</div>}

            <form onSubmit={handleSendPasswordReset}>
              <label>Email Address:</label>
              <input
                type="email"
                required
                placeholder="cashier@azupharmacy.com"
                value={loginEmail}
                onChange={(e) => setLoginEmail(e.target.value)}
              />

              <button type="submit" className="login-btn">
                Send Reset Link
              </button>
            </form>

            <button
              type="button"
              className="link-btn"
              onClick={() => {
                setAuthView('login');
                setAuthError('');
                setAuthInfo('');
              }}
            >
              ← Back to sign in
            </button>
            <p className="auth-hint">
              Can't get into your email? Ask an administrator to set a new
              password for you.
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="login-container">
        <div className="login-card">
          <h2>AZU PHARMACY POS</h2>

          <p>
            Please log in to continue
          </p>

          {authError && (
            <div className="auth-error">
              {authError}
            </div>
          )}

          <form onSubmit={handleLogin}>
            <label>
              Email Address:
            </label>

            <input
              type="email"
              required
              placeholder="cashier@azupharmacy.com"
              value={loginEmail}
              onChange={(e) =>
                setLoginEmail(
                  e.target.value
                )
              }
            />

            <label>
              Password:
            </label>

            <div className="password-input-wrapper">
              <input
                type={
                  showPassword
                    ? 'text'
                    : 'password'
                }
                required
                placeholder="••••••••"
                value={loginPassword}
                onChange={(e) =>
                  setLoginPassword(
                    e.target.value
                  )
                }
              />

              <button
                type="button"
                className="password-toggle"
                onClick={() =>
                  setShowPassword(
                    !showPassword
                  )
                }
              >
                {showPassword
                  ? 'HIDE'
                  : 'SHOW'}
              </button>
            </div>

            <button
              type="submit"
              className="login-btn"
            >
              Sign In
            </button>
          </form>

          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setAuthView('forgot');
              setAuthError('');
              setAuthInfo('');
            }}
          >
            Forgot your password?
          </button>
        </div>
      </div>
    );
  }

  // ============================================================
  // MAIN APP
  // ============================================================
  return (
    <div className="app-container">

      {/* ========================================================
          HEADER
      ======================================================== */}
      <header className="header no-print">

        <div className="user-profile-header">
          <div className="user-info-group">
            <span className="user-email" title={session?.user?.email}>
              {nameOf(session?.user?.email)}
            </span>

            <span className="user-role-badge">
              {userRole.toUpperCase()}
            </span>
          </div>

          <button
            className="logout-btn"
            onClick={handleLogout}
          >
            Sign Out
          </button>
        </div>

        <div className="header-title-row">
          <h1
            className="app-reload-title"
            title="Click to reload the app"
            onClick={() => window.location.reload()}
          >
            AZU PHARMACY POS
          </h1>

          <span
            className={`status-badge ${
              isOnline
                ? 'online'
                : 'offline'
            }`}
          >
            {isOnline
              ? '● Online'
              : '○ Offline'}
          </span>
        </div>

        <div className="controls-bar">

          <div className="nav-tabs">
            {/* A pure cashier's whole job is the approval queue — they
                never see the drug catalog or build tickets themselves,
                so the POS tab doesn't exist for that role. An
                administrator's whole job here is oversight (Admin tab
                only) — they don't sell, build tickets or approve
                payment, so POS doesn't exist for them either. Managers
                outrank cashier but aren't administrator, so they still
                get it. */}
            {userRole !== 'cashier' && userRole !== 'administrator' && (
              <button
                className={
                  activeTab === 'pos'
                    ? 'active-tab'
                    : ''
                }
                onClick={() =>
                  setActiveTab('pos')
                }
              >
                🛒 POS
              </button>
            )}

            {/* Same reasoning — Sales History is for the people actually
                making/approving sales, not for the Admin account. */}
            {userRole !== 'administrator' && (
              <button
                className={
                  activeTab === 'history'
                    ? 'active-tab'
                    : ''
                }
                onClick={() =>
                  setActiveTab(
                    'history'
                  )
                }
              >
                📋 History
              </button>
            )}

            {/* The approval Queue is for cashier or manager only —
                deliberately NOT administrator (approving payment is a
                cashier's job; a manager can stand in for one, for
                accountability an admin account shouldn't double as
                both). A plain salesperson/attendant builds tickets from
                the POS tab instead and never approves payment. */}
            {canApproveTickets && (
              <button
                className={
                  activeTab === 'tickets'
                    ? 'active-tab'
                    : ''
                }
                onClick={() => setActiveTab('tickets')}
              >
                🧾 Queue
                {pendingTickets.length > 0 && (
                  <span className="nav-badge">
                    {pendingTickets.length > 9 ? '9+' : pendingTickets.length}
                  </span>
                )}
              </button>
            )}

            {/* "Restock" as its own top-nav button, and the "+ Add Drug"
                button below, have both moved into the single "Drugs &
                Suppliers" bottom bar (see just after this header) — one
                entry point for everything catalog/supplier-related
                instead of two separate top-nav slots competing for
                space with POS/History/Queue. */}

            {hasRole(userRole, 'administrator') && (
              <button
                className={
                  activeTab === 'admin'
                    ? 'active-tab'
                    : ''
                }
                onClick={handleOpenAdminTab}
              >
                🛡️ Admin
                {unseenManagerChanges > 0 && (
                  <span className="nav-badge">
                    {unseenManagerChanges > 9 ? '9+' : unseenManagerChanges}
                  </span>
                )}
              </button>
            )}
          </div>

          {/* The old single global Retail/Wholesale toggle lived here —
              removed. Each customer's ticket draft now has its own
              compact Retail/Wholesale toggle (different customers can be
              on different price tiers at once), and keeping both was
              just wasted vertical space pushing the cart off-screen. */}
        </div>

      </header>

      {accountModal && (
        <div className="modal-overlay no-print">
          <div className="modal-card">
            <h3>
              {accountModal.mode === 'create'
                ? 'New Account'
                : accountModal.mode === 'edit'
                ? `Edit ${accountModal.profile.full_name || accountModal.profile.email}`
                : `Set Password — ${accountModal.profile.full_name || accountModal.profile.email}`}
            </h3>

            <form className="crud-form" onSubmit={handleSubmitAccountModal}>
              {accountModal.mode !== 'password' && (
                <>
                  <label>Full name</label>
                  <input
                    required
                    value={accountForm.fullName}
                    onChange={(e) => setAccountForm({ ...accountForm, fullName: e.target.value })}
                  />

                  <label>Login email</label>
                  <input
                    type="email"
                    required
                    value={accountForm.email}
                    onChange={(e) => setAccountForm({ ...accountForm, email: e.target.value })}
                  />

                  <label>Role</label>
                  <select
                    value={accountForm.role}
                    onChange={(e) => setAccountForm({ ...accountForm, role: e.target.value })}
                  >
                    <option value="salesperson">Salesperson</option>
                    <option value="cashier">Cashier</option>
                    <option value="manager">Manager</option>
                  </select>
                </>
              )}

              {accountModal.mode !== 'edit' && (
                <>
                  <label>
                    {accountModal.mode === 'create' ? 'Initial password' : 'New password'} (min. 8
                    characters)
                  </label>
                  <div className="form-row">
                    <input
                      required
                      minLength={8}
                      value={accountForm.password}
                      onChange={(e) => setAccountForm({ ...accountForm, password: e.target.value })}
                    />
                    <button type="button" className="cancel-btn" onClick={generateTemporaryPassword}>
                      Generate
                    </button>
                  </div>
                </>
              )}

              {accountModal.mode === 'edit' && (
                <p className="auth-hint">
                  Changing the email keeps all of this person's past sales and approvals —
                  their records are tied to their account, not to the email.
                </p>
              )}

              <div className="modal-actions">
                <button type="button" className="cancel-btn" onClick={() => setAccountModal(null)}>
                  Cancel
                </button>
                <button type="submit" className="save-btn" disabled={isSavingAccount}>
                  {isSavingAccount ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}


      {undeliveredTickets && undeliveredTickets.length > 0 && (
        <div className="undelivered-banner no-print" role="alert">
          ⚠ {undeliveredTickets.length} ticket
          {undeliveredTickets.length === 1 ? '' : 's'} not yet delivered to
          the cashier (
          {isOnline ? 'retrying every few seconds' : 'you are offline'}).
          Keep this screen open until this warning disappears.
        </div>
      )}

      {/* ========================================================
          DRUGS & SUPPLIERS — bottom bar, not top nav.
          Everything catalog/supplier-related (drug CRUD, supplier CRUD,
          restocking from a supplier, the purchase list, stock history)
          lives behind this one entry point now, instead of a separate
          "Restock" tab and a separate "+ Add Drug" button both fighting
          the top nav for room. Cashier/manager only — the two roles that
          actually touch any of this.
      ======================================================== */}
      {canUseRestock && (
        <div className="bottom-bar no-print">
          <button
            className={`bottom-bar-btn ${activeTab === 'catalog' ? 'active-tab' : ''}`}
            onClick={() => setActiveTab('catalog')}
          >
            📦 Drugs, Suppliers &amp; Customers
            {canApproveStockEntries &&
              (pendingStockEntries.length > 0 ||
                pendingStockEntryEdits.length > 0 ||
                pendingSupplierChangeRequests.length > 0 ||
                pendingDrugChangeRequests.length > 0 ||
                pendingCustomerChangeRequests.length > 0) && (
                <span className="nav-badge">
                  {pendingStockEntries.length +
                    pendingStockEntryEdits.length +
                    pendingSupplierChangeRequests.length +
                    pendingDrugChangeRequests.length +
                    pendingCustomerChangeRequests.length >
                  9
                    ? '9+'
                    : pendingStockEntries.length +
                      pendingStockEntryEdits.length +
                      pendingSupplierChangeRequests.length +
                      pendingDrugChangeRequests.length +
                      pendingCustomerChangeRequests.length}
                </span>
              )}
          </button>
        </div>
      )}

      {/* ========================================================
          POS TERMINAL
      ======================================================== */}
      {activeTab === 'pos' && userRole !== 'cashier' && userRole !== 'administrator' && (
        <div className="tickets-screen no-print">

          {stockWarning && (
            <div className="stock-warning-toast">⚠️ {stockWarning}</div>
          )}

          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Build Tickets</h3>
              <span className="admin-section-sub">
                Build a cart for each customer, submit it, and hand them the
                printed ticket to carry to the cashier. You can keep several
                customers' tickets open at once.
              </span>
            </div>

            {mySentBackTickets.length > 0 && (
              <div className="sent-back-section">
                <div className="sent-back-header">
                  ↩️ Sent back for adjustment ({mySentBackTickets.length})
                </div>
                {mySentBackTickets.map((t) => (
                  <div key={t.id} className="sent-back-row">
                    <div>
                      <strong>{t.customerName}</strong>
                      <div className="deleted-drug-meta">
                        {t.items.length} item(s) · ₦{t.total.toLocaleString()}
                      </div>
                      {t.adjustmentReason && (
                        <div className="sent-back-reason">
                          Cashier's note: "{t.adjustmentReason}"
                        </div>
                      )}
                    </div>
                    {ticketDrafts.some((d) => d.resubmitOf === t.id) ? (
                      <span className="sent-back-already-open">
                        Open in "{t.customerName}" draft above
                      </span>
                    ) : (
                      <div className="deleted-drug-actions">
                        <button
                          type="button"
                          className="restore-btn"
                          onClick={() => handleReopenSentBackTicket(t)}
                        >
                          ✎ Reopen & Edit
                        </button>
                        <button
                          type="button"
                          className="permanent-delete-btn"
                          onClick={() => handleDiscardSentBackTicket(t)}
                        >
                          ✕ Discard
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="ticket-draft-tabs">
              {ticketDrafts.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  className={`ticket-draft-tab ${
                    activeDraftId === d.id ? 'active' : ''
                  }`}
                  onClick={() => setActiveDraftId(d.id)}
                >
                  {d.customerName || 'New Customer'} ({d.items.length})
                  {!d.resubmitOf && (
                    <span
                      className="ticket-draft-save"
                      title="Save this cart for later"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleSaveDraftForLater(d.id);
                      }}
                    >
                      💾
                    </span>
                  )}
                  <span
                    className="ticket-draft-close"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeDraft(d.id);
                    }}
                  >
                    ✕
                  </span>
                </button>
              ))}

              <button
                type="button"
                className="ticket-draft-tab new-draft-btn"
                onClick={createNewDraft}
              >
                + New Ticket
              </button>

              <button
                type="button"
                className="ticket-draft-tab saved-carts-btn"
                onClick={handleOpenSavedCartsPanel}
              >
                📂 Saved Carts
              </button>
            </div>

            {isSavedCartsPanelOpen && (
              <div className="saved-carts-panel">
                <div className="admin-section-header">
                  <h3>Saved Carts</h3>
                  <button
                    type="button"
                    className="cancel-btn"
                    onClick={() => setIsSavedCartsPanelOpen(false)}
                  >
                    Close
                  </button>
                </div>

                {savedCartDrafts.length > 0 ? (
                  <div className="ticket-list">
                    {savedCartDrafts.map((saved) => (
                      <div key={saved.id} className="ticket-row ticket-row-detailed">
                        <div className="ticket-row-header">
                          <strong>{saved.label || saved.customerName}</strong>
                          <div className="deleted-drug-meta">
                            {saved.items.length} item{saved.items.length === 1 ? '' : 's'}
                            {' · '}
                            {saved.saleType === 'wholesale' ? 'Wholesale' : 'Retail'}
                            {' · Saved '}
                            {new Date(saved.savedAt).toLocaleString()}
                          </div>
                        </div>
                        <div className="deleted-drug-actions">
                          <button
                            type="button"
                            className="restore-btn"
                            onClick={() => handleResumeSavedCartDraft(saved)}
                          >
                            ▶ Resume
                          </button>
                          <button
                            type="button"
                            className="permanent-delete-btn"
                            onClick={() => handleDiscardSavedCartDraft(saved)}
                          >
                            ✕ Discard
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="admin-section-sub">
                    Nothing saved right now — use the 💾 on an open cart's tab to set it aside.
                  </p>
                )}
              </div>
            )}

            {activeDraft ? (
              <div className="ticket-draft-builder">

                <div className="ticket-builder-catalog">
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search drugs or scan barcode..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                  />

                  <div className="drug-list ticket-drug-list">
                    {drugs && drugs.length > 0 ? (
                      drugs.map((drug) => {
                      const cost = Number(drug.costPrice ?? drug.cost_price ?? 0);
                      const price =
                        activeDraft.saleType === 'wholesale'
                          ? Number(drug.wholesalePrice ?? drug.wholesale_price ?? 0)
                          : Number(drug.retailPrice ?? drug.retail_price ?? 0);

                      return (
                        <div
                          key={drug.id}
                          className="drug-card"
                          onClick={() => addToDraft(activeDraft.id, drug)}
                        >
                          <div className="drug-info">
                            <div className="drug-name">{drug.name}</div>
                            <div className="tags-row">
                              <span className="unit-tag">
                                {drug.unitType || drug.unit_type}
                              </span>
                              {drug.counterSpace && (
                                <span className="unit-tag counter-space-tag" title="Space on the counter">
                                  📍 {drug.counterSpace}
                                </span>
                              )}
                              <span
                                className={`stock-tag ${
                                  drug.stock < 10 ? 'low-stock' : ''
                                }`}
                              >
                                Stock: {drug.stock}
                              </span>
                            </div>
                          </div>

                          <div className="price-stack">
                            {hasRole(userRole, 'manager') && (
                              <div className="price-item cost-price">
                                <small>Cost:</small> ₦{cost.toLocaleString()}
                              </div>
                            )}

                            <div className="price-item highlight">
                              <small>
                                {activeDraft.saleType === 'wholesale'
                                  ? 'Wholesale:'
                                  : 'Retail:'}
                              </small>{' '}
                              ₦{price.toLocaleString()}
                            </div>
                            {/* Edit/Delete removed from here — a drug is now
                                only ever edited or deleted from the Drugs &
                                Suppliers hub, where a soft-delete always goes
                                through an unmissable confirm step instead of
                                being one accidental click away while building
                                a customer's cart. */}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="empty-state">No drugs found.</div>
                  )}
                  </div>
                </div>

                <div className="ticket-builder-cart">
                  {/* A wholesale cart no longer needs a registered
                      customer picked here — that only matters if the
                      person wants to owe, which the cashier sorts out
                      at the till. Both sale types just take a plain
                      name/phone for the receipt, same as retail. */}
                  <div className="customer-input-row">
                    <input
                      type="text"
                      placeholder="Customer Name"
                      value={activeDraft.customerName}
                      onChange={(e) =>
                        setDraftField(activeDraft.id, 'customerName', e.target.value)
                      }
                    />
                    <input
                      type="text"
                      placeholder="Customer Phone"
                      value={activeDraft.customerPhone}
                      onChange={(e) =>
                        setDraftField(activeDraft.id, 'customerPhone', e.target.value)
                      }
                    />
                  </div>

                  <div className="draft-price-toggle">
                    <button
                      type="button"
                      className={activeDraft.saleType === 'retail' ? 'active' : ''}
                      onClick={() => setDraftSaleType(activeDraft.id, 'retail')}
                    >
                      Retail
                    </button>
                    <button
                      type="button"
                      className={activeDraft.saleType === 'wholesale' ? 'active' : ''}
                      onClick={() => setDraftSaleType(activeDraft.id, 'wholesale')}
                    >
                      Wholesale
                    </button>
                  </div>

                  <div
                    className="cart-items-list ticket-items-list"
                    ref={draftCartListRef}
                  >
                    {activeDraft.items.length > 0 ? (
                      activeDraft.items.map((item) => {
                        const pricing = computePackPricing(item);
                        return (
                          <div
                            key={item.id}
                            className={`cart-item ${
                              lastAddedItemId === item.id ? 'just-added' : ''
                            }`}
                          >
                            <div className="cart-item-info">
                              <strong className="cart-item-name">{item.name}</strong>
                              <div className="unit-price">
                                ₦{(item.activePrice || 0).toLocaleString()} /{' '}
                                {item.unitType || item.unit_type}
                              </div>
                              {pricing.hasDiscount && (
                                <div className="pack-discount-note">
                                  Pack discount applied
                                </div>
                              )}
                            </div>

                            <div className="qty-controls">
                              <button
                                onClick={() =>
                                  updateDraftQuantity(activeDraft.id, item.id, -1)
                                }
                                aria-label="Decrease quantity"
                              >
                                -
                              </button>
                              <span>{item.quantity}</span>
                              <button
                                onClick={() =>
                                  updateDraftQuantity(activeDraft.id, item.id, 1)
                                }
                                aria-label="Increase quantity"
                              >
                                +
                              </button>
                            </div>
                          </div>
                        );
                      })
                    ) : (
                      <div className="empty-cart-message">
                        🛒 Tap a drug to add it to this ticket
                      </div>
                    )}
                  </div>

                  <div className="cart-summary">
                    <div className="total-display">
                      <span>Ticket Total</span>
                      <strong>₦{draftTotal(activeDraft).toLocaleString()}</strong>
                    </div>

                    <button
                      className="checkout-btn"
                      disabled={activeDraft.items.length === 0 || isSubmittingTicket}
                      onClick={() => handleSubmitTicket(activeDraft.id)}
                    >
                      {isSubmittingTicket
                        ? 'Submitting…'
                        : '🖨️ Print Ticket & Send to Cashier'}
                    </button>
                  </div>
                </div>

              </div>
            ) : (
              <div className="empty-state">
                No ticket open — tap "+ New Ticket" above to start one.
              </div>
            )}
          </section>

          <section className="admin-section">
            <div className="admin-section-header">
              <h3>My Recent Tickets</h3>
              <span className="admin-section-sub">
                Submitted in the last 2 days
              </span>
            </div>

            {myRecentTickets.length > 0 ? (
              <div className="ticket-list">
                {myRecentTickets.map((t) => (
                  <div key={t.id} className="ticket-row">
                    <div>
                      <strong>
                        {t.dailyNumber ? `#${t.dailyNumber} · ` : ''}
                        {t.customerName}
                      </strong>
                      <div className="deleted-drug-meta">
                        {t.items.length} item(s) · ₦{t.total.toLocaleString()}
                      </div>
                    </div>
                    <span
                      className={`ticket-status-pill status-${t.status.toLowerCase()}`}
                    >
                      {t.status.replace('_', ' ')}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">No tickets yet.</div>
            )}
          </section>

        </div>
      )}

      {/* ========================================================
          SALES HISTORY
      ======================================================== */}
      {activeTab === 'history' && userRole !== 'administrator' && (
        <div className="history-screen no-print">

          {hasRole(userRole, 'manager') && pendingReversalRequests.length > 0 && (
            <section className="admin-section reversal-requests-section">
              <div className="admin-section-header">
                <h3>Pending Reversal Requests</h3>
                <span className="admin-section-sub">
                  A cashier asked to reverse part of a sale — nothing changes
                  on the sale until you approve it from here
                </span>
              </div>

              <div className="ticket-list">
                {pendingReversalRequests.map((request) => (
                  <div key={request.id} className="ticket-row">
                    <div>
                      <strong>
                        {request.saleSnapshot?.customerName || 'Walk-in Customer'}
                      </strong>
                      <div className="deleted-drug-meta">
                        {request.reversals
                          .map((r) => {
                            const item = (request.saleSnapshot?.items || []).find(
                              (i) => String(i.id) === String(r.id)
                            );
                            return `${item?.name || r.id} x${r.quantity}`;
                          })
                          .join(', ')}
                        {' · '}Sale {request.saleId} · requested by{' '}
                        {nameOf(request.requestedByEmail)}
                      </div>
                    </div>

                    <div className="deleted-drug-actions">
                      <button
                        className="restore-btn"
                        onClick={() => handleApproveReversalRequest(request)}
                      >
                        ✓ Approve
                      </button>
                      <button
                        className="permanent-delete-btn"
                        onClick={() => handleRejectReversalRequest(request)}
                      >
                        ✕ Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <div className="history-header-row">

            <h2>
              {hasRole(userRole, 'manager')
                ? 'All Customer Sales History (1 Year)'
                : 'My Sales History (1 Year)'}
            </h2>

            <div className="history-filter-controls">

              <input
                type="text"
                placeholder="Search Customer Name or Phone..."
                value={
                  historySearchTerm
                }
                onChange={(e) =>
                  setHistorySearchTerm(
                    e.target.value
                  )
                }
                className="history-search-input"
              />

              {hasRole(userRole, 'manager') && (
                <select
                  value={
                    historyCashierFilter
                  }
                  onChange={(e) =>
                    setHistoryCashierFilter(
                      e.target.value
                    )
                  }
                  className="history-cashier-select"
                >
                  <option value="all">
                    All Cashiers
                  </option>

                  {Array.from(
                    new Set(
                      salesHistory?.map(
                        (s) =>
                          s.cashierEmail
                      )
                    )
                  ).map((email) => (
                    <option
                      key={email}
                      value={email}
                    >
                      {nameOf(email)}
                    </option>
                  ))}
                </select>
              )}

            </div>
          </div>

          <div className="sales-list">

            {salesHistory &&
            salesHistory.length > 0 ? (
              salesHistory.map((sale) => (
                <div
                  key={sale.id}
                  className="sale-history-card"
                >

                  <div className="sale-card-header">

                    <div>
                      <strong>
                        Receipt #{sale.id}
                      </strong>

                      <span className="sale-date">
                        {' '}
                        -{' '}
                        {new Date(
                          sale.createdAt
                        ).toLocaleString()}
                      </span>
                    </div>

                    <span className="sale-type-pill">
                      {sale.saleType.toUpperCase()}
                    </span>

                  </div>

                  <div className="sale-customer-details">

                    <span>
                      👤{' '}
                      <strong>
                        Customer:
                      </strong>{' '}
                      {sale.customerName ||
                        'Walk-in Customer'}
                    </span>

                    <span>
                      📞{' '}
                      <strong>
                        Phone:
                      </strong>{' '}
                      {sale.customerPhone ||
                        'N/A'}
                    </span>

                    <span>
                      🧑‍💼{' '}
                      <strong>
                        Salesperson:
                      </strong>{' '}
                      {nameOf(sale.attendantEmail) || '— (direct sale)'}
                    </span>

                    <span>
                      💳{' '}
                      <strong>
                        Cashier:
                      </strong>{' '}
                      {nameOf(sale.cashierEmail)}
                    </span>

                  </div>

                  <div className="sale-items-table">

                    {sale.items &&
                      sale.items.map(
                        (item, idx) => (
                          <div
                            key={
                              item.id ||
                              idx
                            }
                            className="sale-item-row"
                          >
                            <span>
                              {item.name} (
                              {item.unitType ||
                                item.unit_type}
                              ) x
                              {
                                item.quantity
                              }
                              {item.reversedQty > 0 && (
                                <span className="reversed-tag">
                                  {' '}
                                  — {item.reversedQty} reversed
                                </span>
                              )}
                            </span>

                            <span>
                              ₦
                              {(
                                item.lineTotal ??
                                (item.activePrice || 0) *
                                  item.quantity
                              ).toLocaleString()}
                            </span>
                          </div>
                        )
                      )}

                  </div>

                  {sale.customerId &&
                    sale.customerBalanceAfter !== null &&
                    sale.customerBalanceAfter !== undefined && (
                      <div className="sale-customer-details">
                        <span>
                          Owed before: ₦
                          {Number(sale.customerBalanceBefore || 0).toLocaleString()}
                        </span>
                        <span>
                          Paid now: ₦{Number(sale.amountPaid || 0).toLocaleString()}
                        </span>
                        <span>
                          {Number(sale.customerBalanceAfter) >= 0
                            ? 'Still owes'
                            : 'Pharmacy owes them'}
                          : ₦{Math.abs(Number(sale.customerBalanceAfter)).toLocaleString()}
                        </span>
                        {Array.isArray(sale.reversalLog) &&
                          sale.reversalLog.some((r) => r.balanceCredit) && (
                            <span>
                              Returned goods credited to account: ₦
                              {sale.reversalLog
                                .reduce(
                                  (sum, r) => sum + Number(r.balanceCredit || 0),
                                  0
                                )
                                .toLocaleString()}
                            </span>
                          )}
                      </div>
                    )}

                  <div className="sale-card-footer">

                    <div>
                      Total Amount:{' '}
                      <strong>
                        ₦
                        {sale.total.toLocaleString()}
                      </strong>
                    </div>

                    <div className="sale-card-actions">
                      {hasRole(userRole, 'manager') && (
                        <button
                          className="reverse-btn"
                          onClick={() => {
                            setReversingSale(sale);
                            setReversalQtys({});
                          }}
                        >
                          ↩️ Reverse Items
                        </button>
                      )}

                      {userRole === 'cashier' && (
                        <button
                          className="reverse-btn"
                          onClick={() => {
                            setReversingSale(sale);
                            setReversalQtys({});
                          }}
                        >
                          ↩️ Request Reversal
                        </button>
                      )}

                      <button
                        className="receipt-btn"
                        onClick={() => {
                          setSaleSuccessData(
                            sale
                          );

                          setShowReceiptModal(
                            true
                          );
                        }}
                      >
                        🖨️ Receipt
                      </button>
                    </div>

                  </div>

                </div>
              ))
            ) : (
              <div className="empty-state">
                No sales history found.
              </div>
            )}

          </div>
        </div>
      )}

      {/* ========================================================
          TICKETS: attendant ticket-building + cashier approval queue
      ======================================================== */}
      {activeTab === 'tickets' && canApproveTickets && (
        <div className="tickets-screen no-print">

          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Payment Queue</h3>
              <span className="admin-section-sub">
                Tickets waiting for payment, oldest first — approve one once
                the customer has paid, or switch to another customer if this
                one is still sorting out payment.
              </span>
            </div>

            {pendingTickets.length > 0 ? (
              <div className="ticket-list">
                {pendingTickets.map((t) => (
                  <div key={t.id} className="ticket-row ticket-row-detailed">
                    <div className="ticket-row-header">
                      <span className="ticket-daily-number">
                        {t.dailyNumber ? `Customer #${t.dailyNumber}` : 'Customer #—'}
                      </span>
                      <span
                        className={`ticket-saletype-badge ${
                          t.saleType === 'wholesale' ? 'wholesale' : 'retail'
                        }`}
                      >
                        {t.saleType === 'wholesale' ? 'Wholesale' : 'Retail'}
                      </span>
                      <strong>{t.customerName}</strong>
                    </div>

                    <ul className="ticket-row-items">
                      {t.items.map((i, idx) => (
                        <li key={idx}>
                          <span className="ticket-row-item-name">{i.name}</span>
                          <span className="ticket-row-item-qty">× {i.quantity}</span>
                        </li>
                      ))}
                    </ul>

                    <div className="deleted-drug-meta">
                      Total Due: ₦{t.total.toLocaleString()} · by {nameOf(t.attendantEmail)}
                    </div>

                    <div className="deleted-drug-actions">
                      <button
                        className="restore-btn"
                        onClick={() => handleOpenApproveModal(t)}
                      >
                        💳 Approve Payment
                      </button>
                      <button
                        className="send-back-btn"
                        onClick={() => handleOpenSendBackModal(t)}
                      >
                        ↩️ Send Back
                      </button>
                      <button
                        className="permanent-delete-btn"
                        onClick={() => handleCancelTicketClick(t)}
                      >
                        ✕ Cancel
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">No pending tickets.</div>
            )}
          </section>

        </div>
      )}

      {/* ========================================================
          DRUGS & SUPPLIERS HUB (cashier or manager) — one entry point,
          five internal sub-tabs. 'restock' is everything that already
          existed here; drugs/suppliers/purchaselist/history are new.
      ======================================================== */}
      {activeTab === 'catalog' && canUseRestock && (
        <div className="admin-section-nav no-print">
          <button
            className={catalogSection === 'restock' ? 'active' : ''}
            onClick={() => setCatalogSection('restock')}
          >
            🚚 Restock
            {canApproveStockEntries &&
              pendingStockEntries.length + pendingStockEntryEdits.length > 0 && (
                <span className="nav-badge">
                  {pendingStockEntries.length + pendingStockEntryEdits.length}
                </span>
              )}
          </button>
          <button
            className={catalogSection === 'drugs' ? 'active' : ''}
            onClick={() => setCatalogSection('drugs')}
          >
            💊 Drugs
            {canApproveStockEntries && pendingDrugChangeRequests.length > 0 && (
              <span className="nav-badge">{pendingDrugChangeRequests.length}</span>
            )}
          </button>
          <button
            className={catalogSection === 'suppliers' ? 'active' : ''}
            onClick={() => setCatalogSection('suppliers')}
          >
            🏭 Suppliers
            {canApproveStockEntries && pendingSupplierChangeRequests.length > 0 && (
              <span className="nav-badge">{pendingSupplierChangeRequests.length}</span>
            )}
          </button>
          <button
            className={catalogSection === 'customers' ? 'active' : ''}
            onClick={() => setCatalogSection('customers')}
          >
            👥 Customers
            {canApproveStockEntries && pendingCustomerChangeRequests.length > 0 && (
              <span className="nav-badge">{pendingCustomerChangeRequests.length}</span>
            )}
          </button>
          <button
            className={catalogSection === 'purchaselist' ? 'active' : ''}
            onClick={() => setCatalogSection('purchaselist')}
          >
            🧾 Purchase List
          </button>
          <button
            className={catalogSection === 'history' ? 'active' : ''}
            onClick={() => setCatalogSection('history')}
          >
            📜 Stock History
          </button>
        </div>
      )}

      {activeTab === 'catalog' && canUseRestock && catalogSection === 'restock' && (
        <div className="tickets-screen no-print">

          {canApproveStockEntries && pendingStockEntries.length > 0 && (
            <section className="admin-section">
              <div className="admin-section-header">
                <h3>Stock Entries Awaiting Approval</h3>
                <span className="admin-section-sub">
                  Submitted by a cashier — nothing in the catalog changes
                  until you approve or reject each one.
                </span>
              </div>

              <div className="ticket-list">
                {pendingStockEntries.map((entry) => (
                  <div key={entry.id} className="ticket-row ticket-row-detailed">
                    <div className="ticket-row-header">
                      <strong>{entry.supplierName}</strong>
                    </div>

                    <ul className="ticket-row-items">
                      {entry.items.map((item, idx) => (
                        <li key={idx}>
                          <span className="ticket-row-item-name">
                            {item.name}
                            {item.isNewDrug ? ' (new drug)' : ''}
                          </span>
                          <span className="ticket-row-item-qty">
                            × {item.quantity}
                          </span>
                          <span className="ticket-row-item-amount">
                            ₦{Number(item.costPrice).toLocaleString()} ea
                          </span>
                        </li>
                      ))}
                    </ul>

                    <div className="deleted-drug-meta">
                      Total Cost: ₦{entry.totalCost.toLocaleString()} · by{' '}
                      {nameOf(entry.enteredByEmail)}
                    </div>

                    <div className="deleted-drug-actions">
                      <button
                        className="restore-btn"
                        onClick={() => handleApproveStockEntry(entry)}
                      >
                        ✓ Approve
                      </button>
                      {isStockEntryEditable(entry) && (
                        <button
                          className="send-back-btn"
                          onClick={() => handleOpenEditStockEntry(entry)}
                        >
                          ✎ Edit
                        </button>
                      )}
                      <button
                        className="permanent-delete-btn"
                        onClick={() => handleOpenRejectStockModal(entry)}
                      >
                        ✕ Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {canApproveStockEntries && pendingStockEntryEdits.length > 0 && (
            <section className="admin-section">
              <div className="admin-section-header">
                <h3>Stock Entry Corrections Awaiting Approval</h3>
                <span className="admin-section-sub">
                  A cashier corrected something on an entry they already
                  submitted — the entry stays as it is until you approve or
                  reject the change.
                </span>
              </div>

              <div className="ticket-list">
                {pendingStockEntryEdits.map((editRequest) => (
                  <div key={editRequest.id} className="ticket-row ticket-row-detailed">
                    <div className="ticket-row-header">
                      <strong>Correction from {nameOf(editRequest.requestedByEmail)}</strong>
                    </div>

                    <ul className="ticket-row-items">
                      {editRequest.proposedItems.map((item, idx) => {
                        const before = editRequest.originalItems.find(
                          (o) => String(o.drugId) === String(item.drugId)
                        );
                        const qtyChanged =
                          before && Number(before.quantity) !== Number(item.quantity);
                        return (
                          <li key={idx}>
                            <span className="ticket-row-item-name">
                              {item.name}
                              {item.isNewDrug ? ' (new drug)' : ''}
                            </span>
                            <span className="ticket-row-item-qty">
                              × {item.quantity}
                              {qtyChanged ? ` (was ${before.quantity})` : ''}
                            </span>
                            <span className="ticket-row-item-amount">
                              ₦{Number(item.costPrice).toLocaleString()} ea
                            </span>
                          </li>
                        );
                      })}
                    </ul>

                    <div className="deleted-drug-meta">
                      New Total: ₦{editRequest.proposedTotalCost.toLocaleString()}
                    </div>

                    <div className="deleted-drug-actions">
                      <button
                        className="restore-btn"
                        onClick={() => handleApproveStockEdit(editRequest)}
                      >
                        ✓ Approve Correction
                      </button>
                      <button
                        className="permanent-delete-btn"
                        onClick={() => handleOpenRejectStockEdit(editRequest)}
                      >
                        ✕ Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Restock From Supplier</h3>
              <span className="admin-section-sub">
                {userRole === 'cashier'
                  ? "Your entries need a manager's approval before stock updates."
                  : 'Your entries update stock immediately.'}
              </span>
            </div>

            <div className="restock-supplier-picker">
              <label>Supplier:</label>
              <select
                value={restockSupplierId}
                onChange={(e) => setRestockSupplierId(e.target.value)}
              >
                <option value="">Select a supplier…</option>
                {(suppliers || [])
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                <option value="__new__">+ New Supplier</option>
              </select>
            </div>

            {restockSupplierId === '__new__' && (
              <div className="new-supplier-form">
                <div className="form-row">
                  <div>
                    <label>Supplier Name:</label>
                    <input
                      type="text"
                      value={newSupplierForm.name}
                      onChange={(e) =>
                        setNewSupplierForm({ ...newSupplierForm, name: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label>Contact Person:</label>
                    <input
                      type="text"
                      value={newSupplierForm.contactPerson}
                      onChange={(e) =>
                        setNewSupplierForm({
                          ...newSupplierForm,
                          contactPerson: e.target.value
                        })
                      }
                    />
                  </div>
                </div>

                <div className="form-row">
                  <div>
                    <label>Phone:</label>
                    <input
                      type="text"
                      value={newSupplierForm.phone}
                      onChange={(e) =>
                        setNewSupplierForm({ ...newSupplierForm, phone: e.target.value })
                      }
                    />
                  </div>
                  <div>
                    <label>Email:</label>
                    <input
                      type="text"
                      value={newSupplierForm.email}
                      onChange={(e) =>
                        setNewSupplierForm({ ...newSupplierForm, email: e.target.value })
                      }
                    />
                  </div>
                </div>

                <div>
                  <label>Address:</label>
                  <input
                    type="text"
                    value={newSupplierForm.address}
                    onChange={(e) =>
                      setNewSupplierForm({ ...newSupplierForm, address: e.target.value })
                    }
                  />
                </div>

                <button
                  type="button"
                  className="save-btn"
                  disabled={isSavingSupplier}
                  onClick={handleSaveNewSupplier}
                >
                  {isSavingSupplier ? 'Saving…' : '✓ Save Supplier & Continue'}
                </button>
              </div>
            )}

            {selectedSupplier && (
              <div className="restock-builder">

                <input
                  type="text"
                  className="search-input"
                  placeholder="Search drugs being restocked..."
                  value={restockSearchTerm}
                  onChange={(e) => setRestockSearchTerm(e.target.value)}
                />

                <div className="drug-list ticket-drug-list restock-drug-list">
                  {(drugs || [])
                    .filter(
                      (d) =>
                        !d.deletedAt &&
                        d.name.toLowerCase().includes(restockSearchTerm.toLowerCase())
                    )
                    .map((d) => (
                      <div
                        key={d.id}
                        className="drug-card"
                        onClick={() => handleAddExistingDrugToRestock(d)}
                      >
                        <div className="drug-info">
                          <div className="drug-name">{d.name}</div>
                          <div className="tags-row">
                            <span className="unit-tag">{d.unitType}</span>
                            {d.counterSpace && (
                              <span className="unit-tag counter-space-tag">📍 {d.counterSpace}</span>
                            )}
                            <span
                              className={`stock-tag ${d.stock < 10 ? 'low-stock' : ''}`}
                            >
                              Stock: {d.stock}
                            </span>
                          </div>
                        </div>
                        <div className="price-stack">
                          <div className="price-item cost-price">
                            <small>Cost:</small> ₦{Number(d.costPrice || 0).toLocaleString()}
                          </div>
                        </div>
                      </div>
                    ))}
                </div>

                <button
                  type="button"
                  className="add-drug-btn restock-new-drug-toggle"
                  onClick={() => setShowNewDrugForm((v) => !v)}
                >
                  {showNewDrugForm ? '✕ Cancel' : '+ Drug Not In Catalog'}
                </button>

                {showNewDrugForm && (
                  <div className="new-drug-line-form">
                    <div className="form-row">
                      <div>
                        <label>Drug Name:</label>
                        <input
                          type="text"
                          value={newDrugLine.name}
                          onChange={(e) =>
                            setNewDrugLine({ ...newDrugLine, name: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <label>Unit Type:</label>
                        <select
                          value={newDrugLine.unitType}
                          onChange={(e) =>
                            setNewDrugLine({ ...newDrugLine, unitType: e.target.value })
                          }
                        >
                          <option value="Sachet">Sachet</option>
                          <option value="Bottle">Bottle</option>
                          <option value="Tube">Tube</option>
                          <option value="Ampoule">Ampoule</option>
                          <option value="Drop">Drop</option>
                          <option value="Vial">Vial</option>
                          <option value="Strip">Strip</option>
                          <option value="Unit">Unit</option>
                        </select>
                      </div>
                    </div>

                    <div className="form-row">
                      <div>
                        <label>Quantity Received:</label>
                        <input
                          type="number"
                          min="1"
                          value={newDrugLine.quantity}
                          onChange={(e) =>
                            setNewDrugLine({ ...newDrugLine, quantity: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <label>Cost Price (₦):</label>
                        <input
                          type="number"
                          min="0"
                          value={newDrugLine.costPrice}
                          onChange={(e) =>
                            setNewDrugLine({ ...newDrugLine, costPrice: e.target.value })
                          }
                        />
                      </div>
                    </div>

                    <PriceRecommendationHint
                      costPrice={newDrugLine.costPrice}
                      priceHistory={null}
                      settings={pricingSettings}
                      onPickRetail={(price) =>
                        setNewDrugLine((prev) => ({ ...prev, retailPrice: String(price) }))
                      }
                      onPickWholesale={(price) =>
                        setNewDrugLine((prev) => ({ ...prev, wholesalePrice: String(price) }))
                      }
                    />

                    <div className="form-row">
                      <div>
                        <label>Retail Price (₦):</label>
                        <input
                          type="number"
                          min="0"
                          value={newDrugLine.retailPrice}
                          onChange={(e) =>
                            setNewDrugLine({ ...newDrugLine, retailPrice: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <label>Wholesale Price (₦):</label>
                        <input
                          type="number"
                          min="0"
                          value={newDrugLine.wholesalePrice}
                          onChange={(e) =>
                            setNewDrugLine({
                              ...newDrugLine,
                              wholesalePrice: e.target.value
                            })
                          }
                        />
                      </div>
                    </div>

                    <div>
                      <label>Barcode (optional):</label>
                      <input
                        type="text"
                        value={newDrugLine.barcode}
                        onChange={(e) =>
                          setNewDrugLine({ ...newDrugLine, barcode: e.target.value })
                        }
                      />
                    </div>

                    <p className="form-section-hint">
                      Optional — only fill these in if this drug is sold at a
                      discount for a half pack or full pack. Leave blank
                      otherwise.
                    </p>

                    <div className="form-row">
                      <div>
                        <label>Half Pack Qty:</label>
                        <input
                          type="number"
                          min="0"
                          value={newDrugLine.halfPackQty}
                          onChange={(e) =>
                            setNewDrugLine({ ...newDrugLine, halfPackQty: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <label>Half Pack Price (₦):</label>
                        <input
                          type="number"
                          min="0"
                          value={newDrugLine.halfPackPrice}
                          onChange={(e) =>
                            setNewDrugLine({ ...newDrugLine, halfPackPrice: e.target.value })
                          }
                        />
                      </div>
                    </div>

                    <div className="form-row">
                      <div>
                        <label>Full Pack Qty:</label>
                        <input
                          type="number"
                          min="0"
                          value={newDrugLine.packQty}
                          onChange={(e) =>
                            setNewDrugLine({ ...newDrugLine, packQty: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <label>Full Pack Price (₦):</label>
                        <input
                          type="number"
                          min="0"
                          value={newDrugLine.packPrice}
                          onChange={(e) =>
                            setNewDrugLine({ ...newDrugLine, packPrice: e.target.value })
                          }
                        />
                      </div>
                    </div>

                    <button
                      type="button"
                      className="save-btn"
                      onClick={handleAddNewDrugLineToRestock}
                    >
                      + Add To Entry
                    </button>
                  </div>
                )}

                <div className="cart-items-list ticket-items-list restock-cart-list">
                  {restockCart.length === 0 ? (
                    <div className="empty-state">
                      No drugs added yet — search above or add one not in the
                      catalog.
                    </div>
                  ) : (
                    restockCart.map((item, idx) => (
                      <div key={idx} className="cart-item restock-cart-item">
                        <div className="restock-cart-item-name">
                          <strong>{item.name}</strong>
                          {item.isNewDrug && (
                            <span className="ticket-saletype-badge wholesale">
                              NEW
                            </span>
                          )}
                        </div>

                        <div className="restock-line-fields">
                          <label>
                            Qty
                            <input
                              type="number"
                              min="1"
                              value={item.quantity}
                              onChange={(e) =>
                                updateRestockLine(
                                  idx,
                                  'quantity',
                                  Number(e.target.value) || 0
                                )
                              }
                            />
                          </label>
                          <label>
                            Cost ₦
                            <input
                              type="number"
                              min="0"
                              value={item.costPrice}
                              onChange={(e) =>
                                updateRestockLine(
                                  idx,
                                  'costPrice',
                                  Number(e.target.value) || 0
                                )
                              }
                            />
                          </label>
                          {/* Retail/wholesale show for EVERY line now —
                              not just new drugs — pre-filled from the
                              catalog for an existing drug, editable in
                              case this supplier/delivery is priced
                              differently. */}
                          <label>
                            Retail ₦
                            <input
                              type="number"
                              min="0"
                              value={item.retailPrice}
                              onChange={(e) =>
                                updateRestockLine(
                                  idx,
                                  'retailPrice',
                                  Number(e.target.value) || 0
                                )
                              }
                            />
                          </label>
                          <label>
                            Wholesale ₦
                            <input
                              type="number"
                              min="0"
                              value={item.wholesalePrice}
                              onChange={(e) =>
                                updateRestockLine(
                                  idx,
                                  'wholesalePrice',
                                  Number(e.target.value) || 0
                                )
                              }
                            />
                          </label>
                          {!item.isNewDrug && (
                            <PriceRecommendationHint
                              costPrice={item.costPrice}
                              priceHistory={
                                (drugs || []).find(
                                  (d) => String(d.id) === String(item.drugId)
                                )?.priceHistory
                              }
                              settings={pricingSettings}
                              onPickRetail={(price) =>
                                updateRestockLine(idx, 'retailPrice', price)
                              }
                              onPickWholesale={(price) =>
                                updateRestockLine(idx, 'wholesalePrice', price)
                              }
                            />
                          )}
                          {item.isNewDrug && (
                            <>
                              <label>
                                Half Pack Qty
                                <input
                                  type="number"
                                  min="0"
                                  value={item.halfPackQty ?? ''}
                                  onChange={(e) =>
                                    updateRestockLine(
                                      idx,
                                      'halfPackQty',
                                      e.target.value === '' ? null : Number(e.target.value)
                                    )
                                  }
                                />
                              </label>
                              <label>
                                Half Pack ₦
                                <input
                                  type="number"
                                  min="0"
                                  value={item.halfPackPrice ?? ''}
                                  onChange={(e) =>
                                    updateRestockLine(
                                      idx,
                                      'halfPackPrice',
                                      e.target.value === '' ? null : Number(e.target.value)
                                    )
                                  }
                                />
                              </label>
                              <label>
                                Full Pack Qty
                                <input
                                  type="number"
                                  min="0"
                                  value={item.packQty ?? ''}
                                  onChange={(e) =>
                                    updateRestockLine(
                                      idx,
                                      'packQty',
                                      e.target.value === '' ? null : Number(e.target.value)
                                    )
                                  }
                                />
                              </label>
                              <label>
                                Full Pack ₦
                                <input
                                  type="number"
                                  min="0"
                                  value={item.packPrice ?? ''}
                                  onChange={(e) =>
                                    updateRestockLine(
                                      idx,
                                      'packPrice',
                                      e.target.value === '' ? null : Number(e.target.value)
                                    )
                                  }
                                />
                              </label>
                            </>
                          )}
                          <button
                            type="button"
                            className="permanent-delete-btn"
                            onClick={() => removeRestockLine(idx)}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="cart-summary">
                  <div className="cart-total">
                    Total Cost: ₦{restockTotalCost.toLocaleString()}
                  </div>

                  <label className="amount-paid-field">
                    Amount Paid Now (₦):
                    <input
                      type="number"
                      min="0"
                      max={restockTotalCost}
                      placeholder="0"
                      value={restockAmountPaid}
                      onChange={(e) => setRestockAmountPaid(e.target.value)}
                    />
                  </label>
                  <div className="deleted-drug-meta">
                    Owed to supplier: ₦
                    {Math.max(
                      0,
                      restockTotalCost - (Number(restockAmountPaid) || 0)
                    ).toLocaleString()}
                  </div>

                  <button
                    type="button"
                    className="checkout-btn"
                    disabled={isSubmittingStockEntry || restockCart.length === 0}
                    onClick={handleSubmitStockEntry}
                  >
                    {isSubmittingStockEntry
                      ? 'Submitting…'
                      : userRole === 'cashier'
                      ? '📤 Submit For Approval'
                      : '✓ Add Stock'}
                  </button>
                </div>
              </div>
            )}
          </section>

          {myStockEntries.length > 0 && (
            <section className="admin-section">
              <div className="admin-section-header">
                <h3>My Recent Stock Entries</h3>
              </div>
              <div className="ticket-list">
                {myStockEntries.slice(0, 10).map((entry) => {
                  const pendingEdit = pendingEditByStockEntryId.get(String(entry.id));
                  return (
                    <div key={entry.id} className="ticket-row">
                      <div>
                        <strong>{entry.supplierName}</strong>
                        <div className="deleted-drug-meta">
                          {entry.items.length} item(s) · ₦
                          {entry.totalCost.toLocaleString()}
                        </div>
                        {entry.status === 'APPLIED' && (
                          <div className="deleted-drug-meta">
                            Paid: ₦{Number(entry.amountPaid || 0).toLocaleString()}
                            {' · '}
                            Owed: ₦
                            {Math.max(
                              0,
                              entry.totalCost - Number(entry.amountPaid || 0)
                            ).toLocaleString()}
                          </div>
                        )}
                        {entry.status === 'REJECTED' && entry.rejectionReason && (
                          <div className="sent-back-reason">
                            Rejected: "{entry.rejectionReason}"
                          </div>
                        )}
                        {pendingEdit && (
                          <div className="sent-back-reason">
                            A correction is awaiting manager approval.
                          </div>
                        )}
                      </div>
                      <div className="deleted-drug-actions">
                        {entry.status === 'APPLIED' &&
                          entry.totalCost - Number(entry.amountPaid || 0) > 0 && (
                            <button
                              className="restore-btn"
                              onClick={() => {
                                setRecordingPaymentFor(entry);
                                setRecordPaymentAmount('');
                              }}
                            >
                              💳 Record Payment
                            </button>
                          )}
                        {isStockEntryEditable(entry) && !pendingEdit && (
                          <button
                            className="send-back-btn"
                            onClick={() => handleOpenEditStockEntry(entry)}
                          >
                            ✎ Edit
                          </button>
                        )}
                        <span
                          className={`ticket-status-pill status-${entry.status.toLowerCase()}`}
                        >
                          {entry.status}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {canApproveStockEntries && (
            <section className="admin-section">
              <div className="admin-section-header">
                <h3>All Stock Entries (last 7 days)</h3>
                <span className="admin-section-sub">
                  Anyone's entry — managers can correct a mistake on any of
                  these, not just their own.
                </span>
              </div>
              <div className="ticket-list">
                {(allStockEntries || [])
                  .filter((e) => {
                    const ageMs = Date.now() - new Date(e.createdAt).getTime();
                    return ageMs <= STOCK_ENTRY_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
                  })
                  .map((entry) => {
                    const pendingEdit = pendingEditByStockEntryId.get(String(entry.id));
                    return (
                      <div key={entry.id} className="ticket-row">
                        <div>
                          <strong>{entry.supplierName}</strong>
                          <div className="deleted-drug-meta">
                            {entry.items.length} item(s) · ₦
                            {entry.totalCost.toLocaleString()} · by{' '}
                            {nameOf(entry.enteredByEmail)}
                          </div>
                          {pendingEdit && (
                            <div className="sent-back-reason">
                              A correction is awaiting approval above.
                            </div>
                          )}
                        </div>
                        <div className="deleted-drug-actions">
                          {isStockEntryEditable(entry) && !pendingEdit && (
                            <button
                              className="send-back-btn"
                              onClick={() => handleOpenEditStockEntry(entry)}
                            >
                              ✎ Edit
                            </button>
                          )}
                          <span
                            className={`ticket-status-pill status-${entry.status.toLowerCase()}`}
                          >
                            {entry.status}
                          </span>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </section>
          )}

        </div>
      )}

      {/* ========================================================
          DRUGS SUB-TAB
      ======================================================== */}
      {activeTab === 'catalog' && canUseRestock && catalogSection === 'drugs' && (
        <div className="tickets-screen no-print">

          {canApproveStockEntries && pendingDrugChangeRequests.length > 0 && (
            <section className="admin-section">
              <div className="admin-section-header">
                <h3>Drug Changes Awaiting Approval</h3>
                <span className="admin-section-sub">
                  Requested by a cashier — nothing in the catalog changes
                  until you approve or reject each one.
                </span>
              </div>
              <div className="ticket-list">
                {pendingDrugChangeRequests.map((request) => {
                  const liveDrug = (drugs || []).find(
                    (d) => String(d.id) === String(request.drugId)
                  );
                  return (
                    <div key={request.id} className="ticket-row ticket-row-detailed">
                      <div className="ticket-row-header">
                        <strong>
                          {request.type === 'DELETE' ? 'Delete' : 'Edit'}:{' '}
                          {request.proposedChanges?.name || liveDrug?.name || 'Unknown drug'}
                        </strong>
                        <div className="deleted-drug-meta">
                          Requested by {nameOf(request.requestedByEmail)}
                        </div>
                      </div>
                      {request.type === 'EDIT' && request.proposedChanges && (
                        <ul className="ticket-row-items">
                          <li>
                            Retail ₦{Number(request.proposedChanges.retailPrice || 0).toLocaleString()}
                            {' · '}Wholesale ₦{Number(request.proposedChanges.wholesalePrice || 0).toLocaleString()}
                            {' · '}Stock {request.proposedChanges.stock ?? 0}
                          </li>
                        </ul>
                      )}
                      <div className="deleted-drug-actions">
                        <button
                          type="button"
                          className="restore-btn"
                          disabled={isApprovingChangeRequestId === request.id}
                          onClick={() => handleApproveChangeRequest('drug', request)}
                        >
                          {isApprovingChangeRequestId === request.id ? 'Approving…' : '✓ Approve'}
                        </button>
                        <button
                          type="button"
                          className="permanent-delete-btn"
                          onClick={() => handleOpenRejectChangeRequest('drug', request)}
                        >
                          ✕ Reject
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Drugs</h3>
              <span className="admin-section-sub">
                Create, edit or delete catalog drugs here — not from the
                sales cart.
              </span>
            </div>

            <div className="catalog-crud-toolbar">
              <input
                type="text"
                className="search-input"
                placeholder="Search drugs..."
                value={drugCrudSearchTerm}
                onChange={(e) => setDrugCrudSearchTerm(e.target.value)}
              />
              <button type="button" className="restore-btn" onClick={handleOpenAddModal}>
                + Add Drug
              </button>
            </div>

            <div className="ticket-list">
              {(drugs || [])
                .filter((d) =>
                  d.name.toLowerCase().includes(drugCrudSearchTerm.trim().toLowerCase())
                )
                .map((drug) => {
                  const pendingReq = pendingDrugChangeRequests.find(
                    (r) => String(r.drugId) === String(drug.id)
                  );
                  return (
                    <div key={drug.id} className="ticket-row ticket-row-detailed">
                      <div className="ticket-row-header">
                        <strong>{drug.name}</strong>
                        <div className="deleted-drug-meta">
                          Stock {drug.stock ?? 0} {drug.unitType} · Retail ₦
                          {Number(drug.retailPrice || 0).toLocaleString()} · Wholesale ₦
                          {Number(drug.wholesalePrice || 0).toLocaleString()}
                          {drug.minStockQty != null && <> · Min {drug.minStockQty}</>}
                          {drug.counterSpace && <> · 📍 {drug.counterSpace}</>}
                        </div>
                        {pendingReq && (
                          <div className="sent-back-reason">
                            A {pendingReq.type === 'DELETE' ? 'deletion' : 'change'} is
                            awaiting manager approval.
                          </div>
                        )}
                      </div>
                      <div className="deleted-drug-actions">
                        <button
                          type="button"
                          className="send-back-btn"
                          onClick={(e) => handleOpenEditModal(drug, e)}
                        >
                          ✎ Edit
                        </button>
                        <button
                          type="button"
                          className="permanent-delete-btn"
                          onClick={(e) => handleDeleteDrug(drug.id, e)}
                        >
                          🗑 Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              {(drugs || []).filter((d) =>
                d.name.toLowerCase().includes(drugCrudSearchTerm.trim().toLowerCase())
              ).length === 0 && <p className="admin-section-sub">No drugs match.</p>}
            </div>
          </section>

        </div>
      )}

      {/* ========================================================
          SUPPLIERS SUB-TAB
      ======================================================== */}
      {activeTab === 'catalog' && canUseRestock && catalogSection === 'suppliers' && (
        <div className="tickets-screen no-print">

          {canApproveStockEntries && pendingSupplierChangeRequests.length > 0 && (
            <section className="admin-section">
              <div className="admin-section-header">
                <h3>Supplier Changes Awaiting Approval</h3>
                <span className="admin-section-sub">
                  Requested by a cashier — nothing changes until you
                  approve or reject each one.
                </span>
              </div>
              <div className="ticket-list">
                {pendingSupplierChangeRequests.map((request) => {
                  const liveSupplier = (suppliers || []).find(
                    (s) => String(s.id) === String(request.supplierId)
                  );
                  return (
                    <div key={request.id} className="ticket-row ticket-row-detailed">
                      <div className="ticket-row-header">
                        <strong>
                          {request.type === 'DELETE' ? 'Delete' : 'Edit'}:{' '}
                          {request.proposedChanges?.name || liveSupplier?.name || 'Unknown supplier'}
                        </strong>
                        <div className="deleted-drug-meta">
                          Requested by {nameOf(request.requestedByEmail)}
                        </div>
                      </div>
                      <div className="deleted-drug-actions">
                        <button
                          type="button"
                          className="restore-btn"
                          disabled={isApprovingChangeRequestId === request.id}
                          onClick={() => handleApproveChangeRequest('supplier', request)}
                        >
                          {isApprovingChangeRequestId === request.id ? 'Approving…' : '✓ Approve'}
                        </button>
                        <button
                          type="button"
                          className="permanent-delete-btn"
                          onClick={() => handleOpenRejectChangeRequest('supplier', request)}
                        >
                          ✕ Reject
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Suppliers</h3>
              <span className="admin-section-sub">
                Create, edit or delete suppliers here — not just inline
                while restocking.
              </span>
            </div>

            <div className="catalog-crud-toolbar">
              <input
                type="text"
                className="search-input"
                placeholder="Search suppliers..."
                value={supplierSearchTerm}
                onChange={(e) => setSupplierSearchTerm(e.target.value)}
              />
              <button
                type="button"
                className="restore-btn"
                onClick={handleOpenAddSupplierModal}
              >
                + New Supplier
              </button>
            </div>

            <div className="ticket-list">
              {(suppliers || [])
                .filter((s) => !s.deletedAt)
                .filter((s) =>
                  s.name.toLowerCase().includes(supplierSearchTerm.trim().toLowerCase())
                )
                .map((supplier) => {
                  const pendingReq = pendingSupplierChangeRequests.find(
                    (r) => String(r.supplierId) === String(supplier.id)
                  );
                  return (
                    <div key={supplier.id} className="ticket-row ticket-row-detailed">
                      <div className="ticket-row-header">
                        <strong>{supplier.name}</strong>
                        <div className="deleted-drug-meta">
                          {[supplier.contactPerson, supplier.phone, supplier.email]
                            .filter(Boolean)
                            .join(' · ') || 'No contact details on file'}
                        </div>
                        {pendingReq && (
                          <div className="sent-back-reason">
                            A {pendingReq.type === 'DELETE' ? 'deletion' : 'change'} is
                            awaiting manager approval.
                          </div>
                        )}
                      </div>
                      <div className="deleted-drug-actions">
                        <button
                          type="button"
                          className="send-back-btn"
                          onClick={() => handleOpenEditSupplierModal(supplier)}
                        >
                          ✎ Edit
                        </button>
                        <button
                          type="button"
                          className="permanent-delete-btn"
                          onClick={() => setDeletingTarget({ kind: 'supplier', item: supplier })}
                        >
                          🗑 Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              {(suppliers || []).filter((s) => !s.deletedAt).length === 0 && (
                <p className="admin-section-sub">No suppliers yet.</p>
              )}
            </div>
          </section>

        </div>
      )}

      {/* ========================================================
          PURCHASE LIST SUB-TAB
      ======================================================== */}
      {activeTab === 'catalog' && canUseRestock && catalogSection === 'purchaselist' && (
        <div className="tickets-screen no-print">

          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Purchase List</h3>
              <span className="admin-section-sub">
                Every drug currently finished or below its minimum —
                always live, nothing to generate or save. A drug drops
                off the moment its stock is topped up, and comes back
                — with whatever quantity and supplier you last set —
                the moment it runs out again.
              </span>
            </div>

            <div className="catalog-crud-toolbar">
              <input
                type="text"
                className="search-input"
                placeholder="Search this list..."
                value={purchasePlanSearchTerm}
                onChange={(e) => setPurchasePlanSearchTerm(e.target.value)}
              />
              <button
                type="button"
                className="restore-btn"
                disabled={purchaseNeedsList.length === 0}
                onClick={handleOpenPrintPurchasePlan}
              >
                🖨 Print / Export
              </button>
            </div>

            <div className="purchase-list-table-wrap">
            <table className="purchase-list-table">
              <thead>
                <tr>
                  <th>Drug</th>
                  <th>Stock</th>
                  <th>Qty</th>
                  <th>Supplier</th>
                  <th>Unit Cost (₦)</th>
                  <th>Line Total (₦)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredPurchaseNeedsList.map((item) => (
                  <tr key={item.drugId}>
                    <td>{item.drugName}</td>
                    <td>
                      {item.currentStock}
                      {item.minStockQty != null && ` / min ${item.minStockQty}`}
                    </td>
                    <td>
                      <input
                        type="number"
                        min="1"
                        value={item.quantity}
                        onChange={(e) =>
                          handleUpdatePlanQuantity(item.drugId, e.target.value)
                        }
                      />
                    </td>
                    <td>
                      {supplierPickerForDrugId === item.drugId ? (
                        <div className="bank-chip-picker">
                          {(suppliers || [])
                            .filter((s) => !s.deletedAt)
                            .map((s) => (
                              <button
                                type="button"
                                key={s.id}
                                className="bank-chip"
                                onClick={() => handlePickPlanSupplier(item.drugId, s)}
                              >
                                {s.name}
                              </button>
                            ))}
                          <button
                            type="button"
                            className="bank-chip"
                            onClick={() => setSupplierPickerForDrugId(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="purchase-plan-supplier">
                          <span
                            onClick={() => setSupplierPickerForDrugId(item.drugId)}
                            style={{ cursor: 'pointer' }}
                            title="Click to choose a supplier"
                          >
                            {item.supplierName || 'Unspecified'}
                          </span>
                          {!item.supplierIsManual && item.supplierName && (
                            <span className="price-rec-source"> (last bought from)</span>
                          )}
                          {item.supplierIsManual && (
                            <button
                              type="button"
                              className="price-rec-chip"
                              onClick={() => handleClearPlanSupplierOverride(item.drugId)}
                              title="Go back to auto (last supplier bought from)"
                            >
                              ↺
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <input
                        type="number"
                        min="0"
                        value={item.unitCost}
                        onChange={(e) =>
                          handleUpdatePlanUnitCost(item.drugId, e.target.value)
                        }
                      />
                    </td>
                    <td>
                      ₦{(Number(item.quantity) * Number(item.unitCost)).toLocaleString()}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="permanent-delete-btn"
                        onClick={() => handleExcludeFromPurchaseList(item.drugId)}
                        title="Not buying this right now"
                      >
                        🚫
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            {filteredPurchaseNeedsList.length === 0 && (
              <p className="admin-section-sub">
                {purchasePlanSearchTerm.trim()
                  ? 'No match in the current purchase list.'
                  : "Nothing needs restocking right now — you're all stocked up."}
              </p>
            )}

            {purchaseNeedsList.length > 0 && (
              <div className="purchase-list-total">
                Total: ₦
                {purchaseNeedsList
                  .reduce((sum, i) => sum + Number(i.quantity) * Number(i.unitCost), 0)
                  .toLocaleString()}
              </div>
            )}
          </section>

          <section className="admin-section">
            <div className="admin-section-header">
              <h3
                onClick={() => setShowNotToBuyList((v) => !v)}
                style={{ cursor: 'pointer' }}
              >
                {showNotToBuyList ? '▾' : '▸'} Not To Buy ({notToBuyList.length})
              </h3>
              <span className="admin-section-sub">
                Drugs you've set aside — they won't show on the
                purchase list above even while finished, until you
                bring them back.
              </span>
            </div>

            {showNotToBuyList && (
              <div className="ticket-list">
                {notToBuyList.map((drug) => (
                  <div key={drug.id} className="ticket-row ticket-row-detailed">
                    <div className="ticket-row-header">
                      <strong>{drug.name}</strong>
                      <div className="deleted-drug-meta">
                        Stock {drug.stock ?? 0} {drug.unitType}
                      </div>
                    </div>
                    <div className="deleted-drug-actions">
                      <button
                        type="button"
                        className="restore-btn"
                        onClick={() => handleReturnToPurchaseList(drug.id)}
                      >
                        ↩ Return to Purchase List
                      </button>
                    </div>
                  </div>
                ))}
                {notToBuyList.length === 0 && (
                  <p className="admin-section-sub">Nothing set aside.</p>
                )}
              </div>
            )}
          </section>

        </div>
      )}

      {/* ========================================================
          STOCK HISTORY SUB-TAB (cashier: own entries; manager: all)
      ======================================================== */}
      {activeTab === 'catalog' && canUseRestock && catalogSection === 'history' && (
        <div className="tickets-screen no-print">
          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Stock History</h3>
              <span className="admin-section-sub">
                {hasRole(userRole, 'manager')
                  ? 'Every stock entry from every cashier and manager.'
                  : 'Stock entries you personally submitted.'}
              </span>
            </div>

            <input
              type="text"
              className="history-search-input"
              placeholder="Search by supplier or drug name..."
              value={stockHistorySearchTerm}
              onChange={(e) => setStockHistorySearchTerm(e.target.value)}
            />

            <div className="ticket-list">
              {(hasRole(userRole, 'manager') ? allStockEntries || [] : myStockEntries || [])
                .filter((entry) => {
                  const term = stockHistorySearchTerm.trim().toLowerCase();
                  if (!term) return true;
                  return (
                    entry.supplierName?.toLowerCase().includes(term) ||
                    (entry.items || []).some((item) =>
                      (item.drugName || '').toLowerCase().includes(term)
                    )
                  );
                })
                .map((entry) => (
                  <div key={entry.id} className="ticket-row ticket-row-detailed">
                    <div className="ticket-row-header">
                      <strong>{entry.supplierName}</strong>
                      <span
                        className={`ticket-status-pill status-${entry.status.toLowerCase()}`}
                      >
                        {entry.status}
                      </span>
                    </div>
                    <div className="deleted-drug-meta">
                      {new Date(entry.createdAt).toLocaleString()} · {entry.items.length} item(s)
                      · ₦{entry.totalCost.toLocaleString()} · Paid ₦
                      {Number(entry.amountPaid || 0).toLocaleString()}
                      {entry.totalCost - Number(entry.amountPaid || 0) > 0 && (
                        <> · Owed ₦{(entry.totalCost - Number(entry.amountPaid || 0)).toLocaleString()}</>
                      )}
                      {hasRole(userRole, 'manager') && <> · by {nameOf(entry.enteredByEmail)}</>}
                    </div>
                  </div>
                ))}
              {(hasRole(userRole, 'manager') ? allStockEntries || [] : myStockEntries || [])
                .length === 0 && <p className="admin-section-sub">No stock entries yet.</p>}
            </div>
          </section>
        </div>
      )}

      {/* ========================================================
          CUSTOMERS SCREEN — wholesale customers, their own place just
          like Drugs & Suppliers. Cashier/manager only.
      ======================================================== */}
      {activeTab === 'catalog' && canUseRestock && catalogSection === 'customers' && (
        <div className="tickets-screen no-print">

          {canApproveStockEntries && pendingCustomerChangeRequests.length > 0 && (
            <section className="admin-section">
              <div className="admin-section-header">
                <h3>Customer Changes Awaiting Approval</h3>
                <span className="admin-section-sub">
                  Requested by a cashier — nothing changes until you
                  approve or reject each one.
                </span>
              </div>
              <div className="ticket-list">
                {pendingCustomerChangeRequests.map((request) => {
                  const liveCustomer = (customers || []).find(
                    (c) => String(c.id) === String(request.customerId)
                  );
                  return (
                    <div key={request.id} className="ticket-row ticket-row-detailed">
                      <div className="ticket-row-header">
                        <strong>
                          {request.type === 'CREATE'
                            ? 'New Customer'
                            : request.type === 'DELETE'
                              ? 'Delete'
                              : 'Edit'}
                          :{' '}
                          {request.proposedChanges?.name || liveCustomer?.name || 'Unknown customer'}
                        </strong>
                        {request.type === 'CREATE' && (
                          <div className="deleted-drug-meta">
                            {(request.proposedChanges?.phones || []).join(', ') || 'No phone on file'}
                            {request.proposedChanges?.address && ` · ${request.proposedChanges.address}`}
                            {' · won\'t be able to owe until approved'}
                          </div>
                        )}
                        <div className="deleted-drug-meta">
                          Requested by {nameOf(request.requestedByEmail)}
                        </div>
                      </div>
                      <div className="deleted-drug-actions">
                        <button
                          type="button"
                          className="restore-btn"
                          disabled={isApprovingChangeRequestId === request.id}
                          onClick={() => handleApproveChangeRequest('customer', request)}
                        >
                          {isApprovingChangeRequestId === request.id ? 'Approving…' : '✓ Approve'}
                        </button>
                        <button
                          type="button"
                          className="permanent-delete-btn"
                          onClick={() => handleOpenRejectChangeRequest('customer', request)}
                        >
                          ✕ Reject
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Wholesale Customers</h3>
              <span className="admin-section-sub">
                Create, edit or delete wholesale customers here. Balances
                only change through a sale.
              </span>
            </div>

            <div className="catalog-crud-toolbar">
              <input
                type="text"
                className="search-input"
                placeholder="Search customers by name or phone..."
                value={customerSearchTerm}
                onChange={(e) => setCustomerSearchTerm(e.target.value)}
              />
              <button
                type="button"
                className="restore-btn"
                onClick={handleOpenAddCustomerModal}
              >
                + New Customer
              </button>
            </div>

            <div className="ticket-list">
              {activeCustomers
                .filter((c) => {
                  const term = customerSearchTerm.trim().toLowerCase();
                  if (!term) return true;
                  return (
                    c.name.toLowerCase().includes(term) ||
                    (c.phone || '').includes(term)
                  );
                })
                .map((customer) => {
                  const pendingReq = pendingCustomerChangeRequests.find(
                    (r) => String(r.customerId) === String(customer.id)
                  );
                  const balance = Number(customer.balance || 0);
                  return (
                    <div key={customer.id} className="ticket-row ticket-row-detailed">
                      <div className="ticket-row-header">
                        <strong>{customer.name}</strong>
                        <div className="deleted-drug-meta">
                          {[customer.phone, customer.email]
                            .filter(Boolean)
                            .join(' · ') || 'No contact details on file'}
                          {balance !== 0 && (
                            <>
                              {' '}
                              ·{' '}
                              {balance > 0
                                ? `owes ₦${balance.toLocaleString()}`
                                : `owed ₦${Math.abs(balance).toLocaleString()}`}
                            </>
                          )}
                        </div>
                        {pendingReq && (
                          <div className="sent-back-reason">
                            A {pendingReq.type === 'DELETE' ? 'deletion' : 'change'} is
                            awaiting manager approval.
                          </div>
                        )}
                      </div>
                      <div className="deleted-drug-actions">
                        <button
                          type="button"
                          className="send-back-btn"
                          onClick={() => handleOpenEditCustomerModal(customer)}
                        >
                          ✎ Edit
                        </button>
                        <button
                          type="button"
                          className="permanent-delete-btn"
                          onClick={() => setDeletingTarget({ kind: 'customer', item: customer })}
                        >
                          🗑 Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              {activeCustomers.length === 0 && (
                <p className="admin-section-sub">No wholesale customers yet.</p>
              )}
            </div>
          </section>

        </div>
      )}

      {/* ========================================================
          ADMINISTRATOR SCREEN
      ======================================================== */}
      {activeTab === 'admin' && hasRole(userRole, 'administrator') && (
        <div className="admin-screen no-print">

          <div className="admin-section-nav">
            <button
              className={adminSection === 'dashboard' ? 'active' : ''}
              onClick={() => setAdminSection('dashboard')}
            >
              📊 Dashboard
            </button>
            <button
              className={adminSection === 'audit' ? 'active' : ''}
              onClick={() => setAdminSection('audit')}
            >
              📜 Audit Log
            </button>
            <button
              className={adminSection === 'search' ? 'active' : ''}
              onClick={() => setAdminSection('search')}
            >
              🔍 Drug Sale Search
            </button>
            <button
              className={adminSection === 'deleted' ? 'active' : ''}
              onClick={() => setAdminSection('deleted')}
            >
              🗑️ Recently Deleted Drugs
            </button>
            <button
              className={adminSection === 'bulk' ? 'active' : ''}
              onClick={() => setAdminSection('bulk')}
            >
              📅 Bulk Delete Sales History
            </button>
            <button
              className={adminSection === 'banks' ? 'active' : ''}
              onClick={() => setAdminSection('banks')}
            >
              🏦 Bank Options
            </button>
            <button
              className={adminSection === 'pricing' ? 'active' : ''}
              onClick={() => setAdminSection('pricing')}
            >
              💰 Pricing Settings
            </button>
            <button
              className={adminSection === 'importexport' ? 'active' : ''}
              onClick={() => setAdminSection('importexport')}
            >
              📥 Import / Export Drugs
            </button>
            <button
              className={adminSection === 'datahub' ? 'active' : ''}
              onClick={() => {
                setAdminSection('datahub');
                setHubPreviewRows(null);
                setHubResult(null);
              }}
            >
              🗂️ Data Hub (all other data)
            </button>
            {userRole === 'administrator' && (
            <button
              className={adminSection === 'roles' ? 'active' : ''}
              onClick={() => {
                setAdminSection('roles');
                if (!allProfiles) handleLoadProfiles();
              }}
            >
              🔑 Account Roles
            </button>
            )}
          </div>

          {adminSection === 'search' && (
          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Drug Sale Search</h3>
              <span className="admin-section-sub">
                Find every sale of a drug, and which account sold it — for
                tracing expensive or sensitive drugs (1-year window)
              </span>
            </div>

            <input
              type="text"
              placeholder="Search by drug name (e.g. Tramadol)..."
              value={drugSearchTerm}
              onChange={(e) => setDrugSearchTerm(e.target.value)}
              className="history-search-input"
            />

            {drugSearchTerm.trim() && (
              drugSaleMatches.length > 0 ? (
                <div className="drug-search-results">
                  {drugSaleMatches.map((match, idx) => (
                    <div
                      key={`${match.saleId}-${idx}`}
                      className="drug-search-row"
                    >
                      <div className="drug-search-main">
                        <strong>{match.drugName}</strong>
                        <span className="deleted-drug-meta">
                          {match.quantity} {match.unitType}
                          {match.reversedQty > 0 &&
                            ` (${match.reversedQty} reversed)`}{' '}
                          · ₦{match.lineTotal.toLocaleString()} · Sale{' '}
                          {match.saleId}
                        </span>
                      </div>

                      <div className="drug-search-accountability">
                        <span>
                          👤 Sold by: <strong>{nameOf(match.cashierEmail)}</strong>
                        </span>
                        <span>
                          🕒 {new Date(match.createdAt).toLocaleString()}
                        </span>
                        <span>
                          Customer: {match.customerName || 'Walk-in Customer'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  No sales of "{drugSearchTerm}" found in the last year.
                </div>
              )
            )}
          </section>
          )}

          {adminSection === 'deleted' && (
          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Recently Deleted Drugs</h3>
              <span className="admin-section-sub">
                Restore or permanently remove items managers have deleted
              </span>
            </div>

            {deletedDrugs && deletedDrugs.length > 0 ? (
              <div className="deleted-drug-list">
                {deletedDrugs.map((drug) => (
                  <div key={drug.id} className="deleted-drug-card">
                    <div className="deleted-drug-info">
                      <strong>{drug.name}</strong>
                      <span className="deleted-drug-meta">
                        Deleted by {nameOf(drug.deletedBy) || 'unknown'} on{' '}
                        {new Date(drug.deletedAt).toLocaleString()}
                      </span>
                    </div>

                    <div className="deleted-drug-actions">
                      <button
                        className="restore-btn"
                        onClick={() => handleRestoreDrug(drug.id)}
                      >
                        ♻️ Restore
                      </button>

                      <button
                        className="permanent-delete-btn"
                        onClick={() =>
                          handlePermanentDelete(drug.id, drug.name)
                        }
                      >
                        🗑️ Delete Permanently
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">No deleted drugs to recover.</div>
            )}
          </section>
          )}

          {adminSection === 'deleted' && (
          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Recently Deleted Customers</h3>
              <span className="admin-section-sub">
                Restore or permanently remove customers managers have deleted
              </span>
            </div>

            {deletedCustomers && deletedCustomers.length > 0 ? (
              <div className="deleted-drug-list">
                {deletedCustomers.map((customer) => (
                  <div key={customer.id} className="deleted-drug-card">
                    <div className="deleted-drug-info">
                      <strong>{customer.name}</strong>
                      <span className="deleted-drug-meta">
                        Deleted by {nameOf(customer.deletedBy) || 'unknown'} on{' '}
                        {new Date(customer.deletedAt).toLocaleString()}
                      </span>
                    </div>

                    <div className="deleted-drug-actions">
                      <button
                        className="restore-btn"
                        onClick={() => handleRestoreCustomer(customer.id)}
                      >
                        ♻️ Restore
                      </button>

                      <button
                        className="permanent-delete-btn"
                        onClick={() =>
                          handlePermanentDeleteCustomer(customer.id, customer.name)
                        }
                      >
                        🗑️ Delete Permanently
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">No deleted customers to recover.</div>
            )}
          </section>
          )}

          {adminSection === 'deleted' && (
          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Recently Deleted Suppliers</h3>
              <span className="admin-section-sub">
                Restore or permanently remove suppliers managers have deleted
              </span>
            </div>

            {deletedSuppliers && deletedSuppliers.length > 0 ? (
              <div className="deleted-drug-list">
                {deletedSuppliers.map((supplier) => (
                  <div key={supplier.id} className="deleted-drug-card">
                    <div className="deleted-drug-info">
                      <strong>{supplier.name}</strong>
                      <span className="deleted-drug-meta">
                        Deleted by {nameOf(supplier.deletedBy) || 'unknown'} on{' '}
                        {new Date(supplier.deletedAt).toLocaleString()}
                      </span>
                    </div>

                    <div className="deleted-drug-actions">
                      <button
                        className="restore-btn"
                        onClick={() => handleRestoreSupplier(supplier.id)}
                      >
                        ♻️ Restore
                      </button>

                      <button
                        className="permanent-delete-btn"
                        onClick={() =>
                          handlePermanentDeleteSupplier(supplier.id, supplier.name)
                        }
                      >
                        🗑️ Delete Permanently
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">No deleted suppliers to recover.</div>
            )}
          </section>
          )}

          {adminSection === 'bulk' && (
          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Bulk Delete Sales History</h3>
              <span className="admin-section-sub">
                Permanently remove sales records within a date range
              </span>
            </div>

            <div className="bulk-delete-panel">
              <div className="bulk-delete-row">
                <div>
                  <label>From:</label>
                  <input
                    type="date"
                    value={bulkDeleteStart}
                    onChange={(e) => setBulkDeleteStart(e.target.value)}
                  />
                </div>

                <div>
                  <label>To:</label>
                  <input
                    type="date"
                    value={bulkDeleteEnd}
                    onChange={(e) => setBulkDeleteEnd(e.target.value)}
                  />
                </div>
              </div>

              <button className="bulk-delete-btn" onClick={handleBulkDeleteSales}>
                Permanently Delete Sales in Range
              </button>
            </div>
          </section>
          )}

          {adminSection === 'banks' && (
          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Bank Options</h3>
              <span className="admin-section-sub">
                The banks a cashier can pick from when recording a transfer
                payment on a ticket
              </span>
            </div>

            <div className="customer-input-row">
              <input
                type="text"
                placeholder="Bank name (e.g. GTBank)"
                value={newBankOptionName}
                onChange={(e) => setNewBankOptionName(e.target.value)}
              />
              <input
                type="color"
                title="Bank color"
                className="bank-color-input"
                value={newBankOptionColor}
                onChange={(e) => setNewBankOptionColor(e.target.value)}
              />
              <button className="save-btn" onClick={handleAddBankOption}>
                + Add Bank
              </button>
            </div>

            {bankOptions && bankOptions.length > 0 ? (
              <div className="deleted-drug-list">
                {bankOptions.map((option) => (
                  <div key={option.id} className="deleted-drug-card">
                    <div className="deleted-drug-info">
                      <span
                        className="bank-color-dot"
                        style={{ backgroundColor: option.color || '#6b7280' }}
                      />
                      <strong>{option.name}</strong>
                    </div>
                    <div className="deleted-drug-actions">
                      <input
                        type="color"
                        title="Change bank color"
                        className="bank-color-input"
                        value={option.color || '#6b7280'}
                        onChange={(e) => handleChangeBankOptionColor(option, e.target.value)}
                      />
                      <button
                        className="permanent-delete-btn"
                        onClick={() => handleRemoveBankOption(option)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                No bank options yet — add one above.
              </div>
            )}
          </section>
          )}

          {adminSection === 'dashboard' && (
          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Dashboard</h3>
              <span className="admin-section-sub">
                A snapshot of where the pharmacy stands right now
              </span>
            </div>

            <div className="dashboard-stat-grid">
              <div className="dashboard-stat-card">
                <span className="dashboard-stat-label">Total Stock Value</span>
                <span className="dashboard-stat-value">
                  ₦{dashboardStockValue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
                <span className="dashboard-stat-hint">At cost, across all drugs in stock</span>
              </div>

              <div className="dashboard-stat-card">
                <span className="dashboard-stat-label">Owed to Suppliers</span>
                <span className="dashboard-stat-value">
                  ₦{dashboardOwedToSuppliers.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
                <span className="dashboard-stat-hint">Unpaid balance on applied stock entries</span>
              </div>

              <div className="dashboard-stat-card">
                <span className="dashboard-stat-label">Today's Sales</span>
                <span className="dashboard-stat-value">
                  ₦{dashboardTodayTotals.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
                <span className="dashboard-stat-hint">
                  {dashboardTodaySales.length} sale{dashboardTodaySales.length === 1 ? '' : 's'} so far today
                </span>
              </div>

              <div className="dashboard-stat-card">
                <span className="dashboard-stat-label">Today's Profit</span>
                <span className="dashboard-stat-value">
                  ₦{dashboardTodayTotals.profit.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </span>
                <span className="dashboard-stat-hint">Revenue minus cost, so far today</span>
              </div>
            </div>

            <div className="dashboard-range-panel">
              <h4>Profit for a Specific Period</h4>
              <div className="bulk-delete-row">
                <div>
                  <label>From:</label>
                  <input
                    type="date"
                    value={dashboardRangeStart}
                    onChange={(e) => setDashboardRangeStart(e.target.value)}
                  />
                </div>
                <div>
                  <label>To:</label>
                  <input
                    type="date"
                    value={dashboardRangeEnd}
                    onChange={(e) => setDashboardRangeEnd(e.target.value)}
                  />
                </div>
              </div>

              {dashboardRangeTotals ? (
                <div className="dashboard-range-result">
                  <div>
                    <span className="dashboard-stat-label">Sales</span>
                    <span className="dashboard-stat-value">
                      ₦{dashboardRangeTotals.revenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                  <div>
                    <span className="dashboard-stat-label">Profit</span>
                    <span className="dashboard-stat-value">
                      ₦{dashboardRangeTotals.profit.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </span>
                  </div>
                  <div>
                    <span className="dashboard-stat-label"># of Sales</span>
                    <span className="dashboard-stat-value">{dashboardRangeTotals.count}</span>
                  </div>
                </div>
              ) : (
                <div className="empty-state">Pick a start and end date to see profit for that period.</div>
              )}
            </div>
          </section>
          )}

          {adminSection === 'pricing' && (
          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Pricing Settings</h3>
              <span className="admin-section-sub">
                The general recommended profit % used by the price suggestion
                everywhere a cost price is entered — a specific drug's own
                price history still overrides this once it has one
              </span>
            </div>

            <div className="pricing-settings-form">
              <div className="pricing-settings-group">
                <h4>Below the high-value threshold</h4>
                <div className="form-row">
                  <div>
                    <label>Wholesale profit %:</label>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={pricingSettingsForm.wholesalePercent}
                      onChange={(e) =>
                        setPricingSettingsForm((prev) => ({ ...prev, wholesalePercent: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label>Retail profit %:</label>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={pricingSettingsForm.retailPercent}
                      onChange={(e) =>
                        setPricingSettingsForm((prev) => ({ ...prev, retailPercent: e.target.value }))
                      }
                    />
                  </div>
                </div>
              </div>

              <div className="pricing-settings-group">
                <h4>At or above the high-value threshold (one price for both)</h4>
                <div className="form-row">
                  <div>
                    <label>Threshold (₦):</label>
                    <input
                      type="number"
                      min="0"
                      value={pricingSettingsForm.highValueThreshold}
                      onChange={(e) =>
                        setPricingSettingsForm((prev) => ({ ...prev, highValueThreshold: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label>Default profit %:</label>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={pricingSettingsForm.highValuePercent}
                      onChange={(e) =>
                        setPricingSettingsForm((prev) => ({ ...prev, highValuePercent: e.target.value }))
                      }
                    />
                  </div>
                </div>
                <div className="form-row">
                  <div>
                    <label>Min % (clamps learned history):</label>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={pricingSettingsForm.highValueMinPercent}
                      onChange={(e) =>
                        setPricingSettingsForm((prev) => ({ ...prev, highValueMinPercent: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label>Max % (clamps learned history):</label>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={pricingSettingsForm.highValueMaxPercent}
                      onChange={(e) =>
                        setPricingSettingsForm((prev) => ({ ...prev, highValueMaxPercent: e.target.value }))
                      }
                    />
                  </div>
                </div>
              </div>

              <button
                className="save-btn"
                disabled={isSavingPricingSettings}
                onClick={handleSavePricingSettings}
              >
                {isSavingPricingSettings ? 'Saving…' : 'Save Pricing Settings'}
              </button>
            </div>
          </section>
          )}

          {adminSection === 'importexport' && (
          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Import / Export Drugs</h3>
              <span className="admin-section-sub">
                Bring drug details in from a CSV or Excel file, or download
                everything currently in the catalog
              </span>
            </div>

            <div className="import-export-panel">
              <div className="import-export-block">
                <h4>Download</h4>
                <p className="admin-section-sub">
                  Every active drug, in the columns this import also understands
                </p>
                <div className="import-export-buttons">
                  <button className="save-btn" onClick={() => handleExportDrugs('csv')}>
                    Download CSV
                  </button>
                  <button className="save-btn" onClick={() => handleExportDrugs('xlsx')}>
                    Download Excel
                  </button>
                </div>
              </div>

              <div className="import-export-block">
                <h4>Upload</h4>
                <p className="admin-section-sub">
                  Columns recognized: name, unitType, costPrice, retailPrice,
                  wholesalePrice, stock, barcode, minStockQty,
                  recommendedPurchaseQty, halfPackQty, halfPackPrice, packQty,
                  packPrice. A row matches an existing drug by barcode, then
                  by name — anything left blank in a matched row is left
                  unchanged. Unmatched rows with a name create a new drug.
                </p>
                <input
                  type="file"
                  accept=".csv,.xlsx,.xls"
                  onChange={(e) => handleDrugImportFileChosen(e.target.files?.[0])}
                />

                {importPreviewRows && (
                  <div className="import-preview">
                    <p>
                      <strong>{importFileName}</strong> — {importPreviewRows.length} row
                      {importPreviewRows.length === 1 ? '' : 's'} found.
                    </p>
                    <div className="import-export-buttons">
                      <button
                        className="save-btn"
                        disabled={isImportingDrugs}
                        onClick={handleConfirmDrugImport}
                      >
                        {isImportingDrugs ? 'Importing…' : 'Confirm Import'}
                      </button>
                      <button className="cancel-btn" onClick={handleCancelDrugImport}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                {importResultSummary && (
                  importResultSummary.success ? (
                    <div className="import-result import-result-success">
                      Created {importResultSummary.created}, updated {importResultSummary.updated}
                      {importResultSummary.skipped.length > 0 &&
                        `, skipped ${importResultSummary.skipped.length}`}
                      .
                      {importResultSummary.skipped.length > 0 && (
                        <ul>
                          {importResultSummary.skipped.map((s) => (
                            <li key={s.row}>Row {s.row}: {s.reason}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : (
                    <div className="import-result import-result-error">
                      Import failed: {importResultSummary.reason}
                    </div>
                  )
                )}
              </div>
            </div>
          </section>
          )}

          {adminSection === 'datahub' && (
          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Data Hub</h3>
              <span className="admin-section-sub">
                Download any dataset as CSV or Excel; upload the ones that are safe to bring in
              </span>
            </div>

            <div className="admin-section-nav">
              {DATA_HUB_DATASETS.filter((d) => !d.adminOnly || userRole === 'administrator').map((d) => (
                <button
                  key={d.key}
                  className={hubDatasetKey === d.key ? 'active' : ''}
                  onClick={() => {
                    setHubDatasetKey(d.key);
                    setHubPreviewRows(null);
                    setHubResult(null);
                    setHubFileName('');
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>

            <div className="import-export-panel">
              <div className="import-export-block">
                <h4>Download — {activeHubDataset.label}</h4>
                <p className="admin-section-sub">{activeHubDataset.help}</p>
                <div className="import-export-buttons">
                  <button className="save-btn" disabled={isHubBusy} onClick={() => handleHubExport('csv')}>
                    Download CSV
                  </button>
                  <button className="save-btn" disabled={isHubBusy} onClick={() => handleHubExport('xlsx')}>
                    Download Excel
                  </button>
                </div>
              </div>

              {activeHubDataset.importFn && (
                <div className="import-export-block">
                  <h4>Upload — {activeHubDataset.label}</h4>
                  <p className="admin-section-sub">
                    Tip: download first, edit the file, then upload it back.
                  </p>
                  <input
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    onChange={(e) => handleHubFileChosen(e.target.files?.[0])}
                  />

                  {hubPreviewRows && (
                    <div className="import-preview">
                      <p>
                        <strong>{hubFileName}</strong> — {hubPreviewRows.length} row
                        {hubPreviewRows.length === 1 ? '' : 's'} found.
                      </p>
                      <div className="modal-actions">
                        <button className="save-btn" disabled={isHubBusy} onClick={handleHubConfirmImport}>
                          {isHubBusy ? 'Importing…' : 'Confirm Import'}
                        </button>
                        <button
                          className="cancel-btn"
                          onClick={() => {
                            setHubPreviewRows(null);
                            setHubFileName('');
                          }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {hubResult &&
                    (hubResult.success ? (
                      <div className="import-result">
                        Created {hubResult.created}, updated {hubResult.updated}
                        {hubResult.skipped && hubResult.skipped.length > 0 && (
                          <>
                            , skipped {hubResult.skipped.length}:
                            <ul>
                              {hubResult.skipped.slice(0, 10).map((x, i) => (
                                <li key={i}>
                                  Row {x.row}: {x.reason}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="import-result import-result-error">
                        Import failed: {hubResult.reason}
                      </div>
                    ))}
                </div>
              )}

              {activeHubDataset.exportOnly && (
                <p className="auth-hint">
                  This dataset is download-only — sales, stock history, tickets and the audit trail
                  can't be uploaded, so records can't be rewritten after the fact.
                </p>
              )}
            </div>
          </section>
          )}

          {adminSection === 'roles' && userRole === 'administrator' && (
          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Accounts</h3>
              <span className="admin-section-sub">
                Create accounts, edit names / emails / roles, set passwords,
                deactivate. Administrator accounts can only be changed in
                Supabase.
              </span>
            </div>

            <div className="form-row">
              <button className="save-btn" onClick={handleOpenCreateAccount}>
                ➕ New Account
              </button>
              <button className="cancel-btn" disabled={isLoadingProfiles} onClick={handleLoadProfiles}>
                {isLoadingProfiles ? 'Loading…' : '🔄 Refresh List'}
              </button>
            </div>

            {allProfiles && allProfiles.length > 0 ? (
              <div className="profile-role-list">
                {allProfiles.map((profile) => {
                  const isAdminTarget = profile.role === 'administrator';
                  return (
                    <div key={profile.id} className="profile-role-card">
                      <div className="profile-role-info">
                        <strong>
                          {profile.full_name || '(no name set)'}
                          {profile.is_active === false && ' — DEACTIVATED'}
                        </strong>
                        <span className="deleted-drug-meta">{profile.email || profile.id}</span>
                        <span className="deleted-drug-meta">Role: {profile.role}</span>
                      </div>

                      {isAdminTarget ? (
                        <span className="deleted-drug-meta">
                          🔒 Administrator — managed in Supabase only
                        </span>
                      ) : (
                        <div className="profile-account-actions">
                          <select
                            value={profile.role}
                            disabled={savingProfileId === profile.id}
                            onChange={(e) => handleChangeUserRole(profile, e.target.value)}
                          >
                            <option value="salesperson">Salesperson</option>
                            <option value="cashier">Cashier</option>
                            <option value="manager">Manager</option>
                          </select>
                          <button className="cancel-btn" onClick={() => handleOpenEditAccount(profile)}>
                            Edit
                          </button>
                          <button className="cancel-btn" onClick={() => handleOpenSetPassword(profile)}>
                            Set Password
                          </button>
                          <button
                            className="cancel-btn"
                            disabled={savingProfileId === profile.id}
                            onClick={() => handleToggleAccountActive(profile)}
                          >
                            {profile.is_active === false ? 'Reactivate' : 'Deactivate'}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state">
                {allProfiles ? 'No accounts found.' : 'Hit "Refresh List" to load accounts.'}
              </div>
            )}
          </section>
          )}

          {adminSection === 'audit' && (
          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Audit Log</h3>
              <span className="admin-section-sub">
                Every sensitive action taken by managers and administrators
              </span>
            </div>

            {auditActionTypes.length > 0 && (
              <div className="admin-section-nav audit-filter-nav">
                <button
                  className={auditActionFilter === 'all' ? 'active' : ''}
                  onClick={() => setAuditActionFilter('all')}
                >
                  All
                </button>
                {auditActionTypes.map((action) => (
                  <button
                    key={action}
                    className={auditActionFilter === action ? 'active' : ''}
                    onClick={() => setAuditActionFilter(action)}
                  >
                    {action
                      .replace(/_/g, ' ')
                      .replace(/\b\w/g, (c) => c.toUpperCase())}
                  </button>
                ))}
              </div>
            )}

            {filteredAuditLog.length > 0 ? (
              <div className="audit-log-list">
                {filteredAuditLog.map((entry) => (
                  <div key={entry.id} className="audit-log-entry">
                    <div className="audit-log-main">
                      <strong>{entry.action.replace(/_/g, ' ')}</strong>
                      <span className="audit-log-meta">
                        {nameOf(entry.actorEmail)} ({entry.actorRole}) ·{' '}
                        {new Date(entry.createdAt).toLocaleString()}
                      </span>
                    </div>

                    {entry.details && (
                      <div className="audit-log-details">
                        {(() => {
                          try {
                            const parsed = JSON.parse(entry.details);
                            return Object.entries(parsed)
                              .map(([k, v]) => `${k}: ${v}`)
                              .join(' · ');
                          } catch {
                            return entry.details;
                          }
                        })()}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="empty-state">
                {auditActionFilter === 'all'
                  ? 'No audit log entries yet.'
                  : 'No entries of this type yet.'}
              </div>
            )}
          </section>
          )}

        </div>
      )}

      {/* ========================================================
          RECEIPT MODAL
      ======================================================== */}
      {showReceiptModal &&
        saleSuccessData && (
          <div className="receipt-container">

            <div className="receipt-card">

              <div className="receipt-header">

                <h2>
                  Alimosho Pharmacy
                </h2>

                <p>
                  Sales Receipt
                </p>

                <p>
                  <strong>
                    Receipt #:
                  </strong>{' '}
                  {saleSuccessData.id}
                </p>

                <p>
                  <strong>
                    Cashier:
                  </strong>{' '}
                  {
                    nameOf(saleSuccessData.cashierEmail)
                  }
                </p>

                <p>
                  <strong>
                    Customer:
                  </strong>{' '}
                  {
                    saleSuccessData.customerName
                  }{' '}
                  (
                  {
                    saleSuccessData.customerPhone
                  }
                  )
                </p>

                <p>
                  <strong>
                    Date:
                  </strong>{' '}
                  {new Date(
                    saleSuccessData.createdAt
                  ).toLocaleString()}
                </p>

              </div>

              <hr />

              <div className="receipt-items">

                {saleSuccessData.items.map(
                  (item, index) => (
                    <div
                      key={
                        item.id ||
                        index
                      }
                      className="receipt-item-row"
                    >
                      <span>
                        {item.name} (
                        {item.unitType ||
                          item.unit_type}
                        ) x
                        {
                          item.quantity
                        }
                      </span>

                      <span>
                        ₦
                        {(
                          item.lineTotal ??
                          (item.activePrice || 0) *
                            item.quantity
                        ).toLocaleString()}
                      </span>
                    </div>
                  )
                )}

              </div>

              <hr />

              <div className="receipt-total">

                <strong>
                  PURCHASE TOTAL:
                </strong>

                <strong>
                  ₦
                  {saleSuccessData.total.toLocaleString()}
                </strong>

              </div>

              {saleSuccessData.customerId &&
                saleSuccessData.customerBalanceAfter !== null &&
                saleSuccessData.customerBalanceAfter !== undefined && (
                  <>
                    <div className="receipt-total">
                      <span>Amount Paid Now:</span>
                      <span>₦{Number(saleSuccessData.amountPaid || 0).toLocaleString()}</span>
                    </div>
                    <hr />
                    <div className="receipt-total">
                      <span>Owed Before This Sale:</span>
                      <span>
                        ₦{Number(saleSuccessData.customerBalanceBefore || 0).toLocaleString()}
                      </span>
                    </div>
                    <div className="receipt-total">
                      <strong>
                        {Number(saleSuccessData.customerBalanceAfter) >= 0
                          ? 'Still Owes:'
                          : 'Pharmacy Owes Customer:'}
                      </strong>
                      <strong>
                        ₦
                        {Math.abs(Number(saleSuccessData.customerBalanceAfter)).toLocaleString()}
                      </strong>
                    </div>
                  </>
                )}

              <p className="receipt-footer">
                Thank you for your
                patronage!
              </p>

              <div className="receipt-actions no-print">

                <button
                  className="print-btn"
                  onClick={() =>
                    window.print()
                  }
                >
                  🖨️ Print Receipt
                </button>

                <button
                  className="close-btn"
                  onClick={() => {
                    setShowReceiptModal(
                      false
                    );

                    setSaleSuccessData(
                      null
                    );
                  }}
                >
                  Close & New Sale
                </button>

              </div>

            </div>
          </div>
        )}

      {/* ========================================================
          TICKET SLIP — what the customer carries to the cashier.
          Separate from the receipt modal above, which only ever shows
          a completed/PAID sale.
      ======================================================== */}
      {printingTicket && (
        <div className="receipt-container">
          <div className="receipt-card">

            <div className="receipt-header">
              <h2>Alimosho Pharmacy</h2>
              <p>Please pay at the till — show this to the cashier</p>
            </div>

            <div>Ticket #: {printingTicket.id}</div>
            {printingTicket.dailyNumber && (
              <div>Customer #: {printingTicket.dailyNumber}</div>
            )}
            <div>Customer: {printingTicket.customerName}</div>

            <div className="receipt-items">
              {printingTicket.items.map((item, idx) => (
                <div key={idx} className="receipt-item-row">
                  <span>
                    {item.name} ({item.unitType}) x{item.quantity}
                  </span>
                  <span>
                    ₦
                    {(
                      item.lineTotal ?? (item.activePrice || 0) * item.quantity
                    ).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>

            <div className="receipt-total">
              Total Due: ₦{printingTicket.total.toLocaleString()}
            </div>

            <p className="receipt-footer">
              Not yet paid — take this to the cashier to complete your
              purchase.
            </p>

            <div className="receipt-actions no-print">
              <button className="print-btn" onClick={() => window.print()}>
                🖨️ Print Ticket
              </button>

              <button
                className="close-btn"
                onClick={() => setPrintingTicket(null)}
              >
                Close
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================
          PURCHASE LIST PRINT VIEW — a dedicated printable block,
          NOT inside a .no-print wrapper (only its own action buttons
          are), so printing it actually produces a page instead of a
          blank one.
      ======================================================== */}
      {printingPurchasePlan && (
        <div className="receipt-container">
          <div className="receipt-card purchase-print-card">

            <div className="receipt-header">
              <h2>Alimosho Pharmacy</h2>
              <p>Purchase List — {new Date().toLocaleDateString()}</p>
            </div>

            {printingPurchasePlan.map((group) => (
              <div key={group.supplierName} className="purchase-print-group">
                <h3>{group.supplierName}</h3>
                <div className="receipt-items">
                  {group.items.map((item) => (
                    <div key={item.drugId} className="receipt-item-row">
                      <span>
                        {item.drugName} x{item.quantity}
                      </span>
                      <span>
                        ₦{(Number(item.quantity) * Number(item.unitCost)).toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="purchase-print-group-total">
                  Subtotal: ₦
                  {group.items
                    .reduce((sum, i) => sum + Number(i.quantity) * Number(i.unitCost), 0)
                    .toLocaleString()}
                </div>
              </div>
            ))}

            <div className="receipt-total">
              Grand Total: ₦
              {printingPurchasePlan
                .flatMap((g) => g.items)
                .reduce((sum, i) => sum + Number(i.quantity) * Number(i.unitCost), 0)
                .toLocaleString()}
            </div>

            <div className="receipt-actions no-print">
              <button className="print-btn" onClick={() => window.print()}>
                🖨️ Print
              </button>
              <button
                className="close-btn"
                onClick={() => setPrintingPurchasePlan(null)}
              >
                Close
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================
          CASHIER: APPROVE PAYMENT MODAL
      ======================================================== */}
      {approvingTicket && (
        <div className="modal-overlay">
          <div className="modal-card">

            <h3>Approve Payment — {approvingTicket.customerName}</h3>

            <div className="ticket-row-header approval-modal-header">
              <span className="ticket-daily-number">
                {approvingTicket.dailyNumber
                  ? `Customer #${approvingTicket.dailyNumber}`
                  : 'Customer #—'}
              </span>
              <span
                className={`ticket-saletype-badge ${
                  approvingTicket.saleType === 'wholesale' ? 'wholesale' : 'retail'
                }`}
              >
                {approvingTicket.saleType === 'wholesale' ? 'Wholesale' : 'Retail'}
              </span>
            </div>

            <ul className="ticket-row-items approval-modal-items">
              {approvingTicket.items.map((item, idx) => (
                <li key={idx}>
                  <span className="ticket-row-item-name">{item.name}</span>
                  <span className="ticket-row-item-qty">× {item.quantity}</span>
                  <span className="ticket-row-item-amount">
                    ₦
                    {(
                      item.lineTotal ?? (item.activePrice || 0) * item.quantity
                    ).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>

            {approvingTicket.saleType === 'wholesale' && !approvingTicket.customerId && (
              <div className="wholesale-customer-picker">
                {!isLinkingCustomerForApproval ? (
                  <button
                    type="button"
                    className="restore-btn"
                    onClick={() => {
                      setIsLinkingCustomerForApproval(true);
                      setApprovalCustomerSearchTerm('');
                    }}
                  >
                    👤 This customer wants to owe / use an account
                  </button>
                ) : (
                  <div className="wholesale-customer-search">
                    <input
                      type="text"
                      className="search-input"
                      autoFocus
                      placeholder="Search customer by name or phone..."
                      value={approvalCustomerSearchTerm}
                      onChange={(e) => setApprovalCustomerSearchTerm(e.target.value)}
                    />
                    <div className="ticket-list">
                      {activeCustomers
                        .filter((c) => {
                          const term = approvalCustomerSearchTerm.trim().toLowerCase();
                          if (!term) return true;
                          return (
                            c.name.toLowerCase().includes(term) ||
                            (c.phone || '').includes(term)
                          );
                        })
                        .slice(0, 8)
                        .map((c) => (
                          <div
                            key={c.id}
                            className="ticket-row"
                            style={{ cursor: 'pointer' }}
                            onClick={() => handleLinkExistingCustomerForApproval(c)}
                          >
                            {c.name}
                            {c.phone && ` · ${c.phone}`}
                            {Number(c.balance || 0) > 0 &&
                              ` (owes ₦${Number(c.balance).toLocaleString()})`}
                          </div>
                        ))}
                      {activeCustomers.length === 0 && (
                        <p className="admin-section-sub">
                          No registered wholesale customers yet — add one below.
                        </p>
                      )}
                    </div>
                    <p className="admin-section-sub">
                      Not on file yet? Adding them sends a request for a
                      manager's approval — they can't owe until that's
                      approved, so this sale still needs full payment
                      for now.
                    </p>
                    <div className="deleted-drug-actions">
                      <button
                        type="button"
                        className="restore-btn"
                        onClick={() => {
                          setCustomerPickerForApproval(true);
                          handleOpenAddCustomerModal();
                        }}
                      >
                        + New Customer
                      </button>
                      <button
                        type="button"
                        className="permanent-delete-btn"
                        onClick={() => setIsLinkingCustomerForApproval(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {approvingTicket.saleType === 'wholesale' && approvingTicket.customerId && (() => {
              const customer = customersById.get(String(approvingTicket.customerId));
              const balanceBefore = Number(customer?.balance || 0);
              const minimumRequired = Math.max(0, balanceBefore);
              const paidSoFar =
                (Number(paymentCash) || 0) +
                paymentElectronicLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
              const balanceAfter = balanceBefore + approvingTicket.total - paidSoFar;
              return (
                <div className="wholesale-balance-panel">
                  <div>
                    <small>Owed before this sale</small>
                    <strong>₦{balanceBefore.toLocaleString()}</strong>
                  </div>
                  <div>
                    <small>Paying now</small>
                    <strong>₦{paidSoFar.toLocaleString()}</strong>
                  </div>
                  <div>
                    <small>{balanceAfter >= 0 ? 'Will still owe' : 'Pharmacy will owe them'}</small>
                    <strong>₦{Math.abs(balanceAfter).toLocaleString()}</strong>
                  </div>
                  {minimumRequired > 0 && (
                    <p className="sent-back-reason">
                      Minimum required to proceed: ₦{minimumRequired.toLocaleString()}{' '}
                      (clears what was owed before this ticket).
                    </p>
                  )}
                </div>
              );
            })()}

            <p className="form-section-hint">
              Total Due: ₦{approvingTicket.total.toLocaleString()}. Choose how
              it was paid — card and transfer both need a bank, and Split
              lets you combine cash with several card/transfer lines (handy
              if a customer transferred more than once).
            </p>

            <div className="payment-method-selector">
              {[
                { key: 'cash', label: '💵 Cash' },
                { key: 'card', label: '💳 Card' },
                { key: 'transfer', label: '🏦 Transfer' },
                { key: 'split', label: '🔀 Split' }
              ].map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={paymentMethod === m.key ? 'active' : ''}
                  onClick={() => handleSelectPaymentMethod(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {(paymentMethod === 'cash' || paymentMethod === 'split') && (
              <div className="form-row">
                <div>
                  <label>Cash (₦):</label>
                  <input
                    type="number"
                    min="0"
                    value={paymentCash}
                    onChange={(e) => setPaymentCash(e.target.value)}
                  />
                </div>
              </div>
            )}

            {(paymentMethod === 'card' ||
              paymentMethod === 'transfer' ||
              paymentMethod === 'split') && (
              <div className="electronic-lines">
                {paymentElectronicLines.map((line) => (
                  <div key={line.id} className="form-row electronic-line">
                    <div>
                      <label>{line.type === 'card' ? 'Card (₦):' : 'Transfer (₦):'}</label>
                      <input
                        type="number"
                        min="0"
                        value={line.amount}
                        onChange={(e) =>
                          handleUpdateElectronicLine(line.id, { amount: e.target.value })
                        }
                      />
                    </div>
                    <div>
                      <label>Bank:</label>
                      <div className="bank-chip-picker">
                        {(bankOptions || []).map((b) => (
                          <button
                            type="button"
                            key={b.id}
                            className={`bank-chip ${line.bank === b.name ? 'selected' : ''}`}
                            style={{
                              backgroundColor: line.bank === b.name ? (b.color || '#6b7280') : 'transparent',
                              borderColor: b.color || '#6b7280',
                              color: line.bank === b.name ? '#fff' : (b.color || '#6b7280')
                            }}
                            onClick={() => handleUpdateElectronicLine(line.id, { bank: b.name })}
                          >
                            {b.name}
                          </button>
                        ))}
                        {(!bankOptions || bankOptions.length === 0) && (
                          <span className="admin-section-sub">
                            No banks set up yet — add one from Admin → Bank Options.
                          </span>
                        )}
                      </div>
                    </div>
                    {paymentMethod === 'split' && (
                      <button
                        type="button"
                        className="permanent-delete-btn"
                        onClick={() => handleRemoveElectronicLine(line.id)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}

                {paymentMethod === 'split' && (
                  <div className="deleted-drug-actions">
                    <button
                      type="button"
                      className="send-back-btn"
                      onClick={() => handleAddElectronicLine('card')}
                    >
                      + Card line
                    </button>
                    <button
                      type="button"
                      className="send-back-btn"
                      onClick={() => handleAddElectronicLine('transfer')}
                    >
                      + Transfer line
                    </button>
                  </div>
                )}
              </div>
            )}

            <p className="form-section-hint">
              Entered so far: ₦
              {(
                (Number(paymentCash) || 0) +
                paymentElectronicLines.reduce((s, l) => s + (Number(l.amount) || 0), 0)
              ).toLocaleString()}{' '}
              of ₦{approvingTicket.total.toLocaleString()}
            </p>

            <div className="modal-actions">
              <button
                type="button"
                className="save-btn"
                disabled={isApprovingTicket}
                onClick={handleConfirmApproval}
              >
                {isApprovingTicket ? 'Approving…' : 'Confirm Payment'}
              </button>

              <button
                type="button"
                className="cancel-btn"
                onClick={() => setApprovingTicket(null)}
              >
                Cancel
              </button>

              {approvingTicket.saleType === 'wholesale' && approvingTicket.customerId && (
                <button
                  type="button"
                  className="permanent-delete-btn"
                  onClick={() => {
                    const ticketToSendBack = approvingTicket;
                    setApprovingTicket(null);
                    handleOpenSendBackModal(ticketToSendBack);
                  }}
                >
                  ↩ Send Back to Salesperson
                </button>
              )}
            </div>

          </div>
        </div>
      )}

      {/* ========================================================
          CASHIER: SEND TICKET BACK FOR ADJUSTMENT MODAL
          No drug list here on purpose — the cashier isn't editing the
          cart, just flagging it back with a reason.
      ======================================================== */}
      {sendingBackTicket && (
        <div className="modal-overlay">
          <div className="modal-card">

            <h3>Send Back — {sendingBackTicket.customerName}</h3>

            <p className="form-section-hint">
              This sends the ticket back to {nameOf(sendingBackTicket.attendantEmail)}{' '}
              to adjust the cart (drop something the customer can't afford,
              add something they forgot). It leaves the payment queue until
              they resubmit it — their place in line (
              {sendingBackTicket.dailyNumber
                ? `Customer #${sendingBackTicket.dailyNumber}`
                : 'their number'}
              ) is kept.
            </p>

            <div>
              <label>Reason for the attendant:</label>
              <textarea
                rows={3}
                value={sendBackReason}
                onChange={(e) => setSendBackReason(e.target.value)}
                placeholder="e.g. Customer can't afford the Amoxicillin — remove it"
              />
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="save-btn"
                disabled={isSendingBackTicket}
                onClick={handleConfirmSendBack}
              >
                {isSendingBackTicket ? 'Sending…' : 'Send Back'}
              </button>

              <button
                type="button"
                className="cancel-btn"
                onClick={() => setSendingBackTicket(null)}
              >
                Cancel
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================
          MANAGER: REJECT STOCK ENTRY MODAL
      ======================================================== */}
      {rejectingStockEntry && (
        <div className="modal-overlay">
          <div className="modal-card">

            <h3>Reject Stock Entry — {rejectingStockEntry.supplierName}</h3>

            <p className="form-section-hint">
              Nothing changes in the catalog — this just tells{' '}
              {nameOf(rejectingStockEntry.enteredByEmail)} why it was turned down.
            </p>

            <div>
              <label>Reason:</label>
              <textarea
                rows={3}
                value={stockRejectReason}
                onChange={(e) => setStockRejectReason(e.target.value)}
                placeholder="e.g. Wrong cost prices entered — please re-check the invoice"
              />
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="save-btn"
                disabled={isRejectingStockEntry}
                onClick={handleConfirmRejectStockEntry}
              >
                {isRejectingStockEntry ? 'Rejecting…' : 'Reject'}
              </button>

              <button
                type="button"
                className="cancel-btn"
                onClick={() => setRejectingStockEntry(null)}
              >
                Cancel
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================
          EDIT STOCK ENTRY MODAL (correcting a mistake, within the
          7-day edit window)
      ======================================================== */}
      {editingStockEntry && (
        <div className="modal-overlay">
          <div className="modal-card">

            <h3>Edit Stock Entry — {editingStockEntry.supplierName}</h3>

            <p className="form-section-hint">
              {editingStockEntry.status === 'APPLIED' && userRole === 'cashier'
                ? "Stock already moved from this entry — your correction will need a manager's approval before it takes effect."
                : editingStockEntry.status === 'APPLIED'
                ? 'Stock already moved from this entry — saving will adjust stock immediately by the difference.'
                : "This entry hasn't been approved yet — your correction applies straight away."}
            </p>

            <div className="cart-items-list restock-cart-list edit-stock-items-list">
              {editStockItems.map((item, idx) => (
                <div key={idx} className="cart-item restock-cart-item">
                  <div className="restock-cart-item-name">
                    <strong>{item.name}</strong>
                    {item.isNewDrug && (
                      <span className="ticket-saletype-badge wholesale">NEW</span>
                    )}
                  </div>

                  <div className="restock-line-fields">
                    <label>
                      Qty
                      <input
                        type="number"
                        min="0"
                        value={item.quantity}
                        onChange={(e) =>
                          updateEditStockItem(idx, 'quantity', e.target.value)
                        }
                      />
                    </label>
                    <label>
                      Cost ₦
                      <input
                        type="number"
                        min="0"
                        value={item.costPrice}
                        onChange={(e) =>
                          updateEditStockItem(idx, 'costPrice', e.target.value)
                        }
                      />
                    </label>
                    <label>
                      Retail ₦
                      <input
                        type="number"
                        min="0"
                        value={item.retailPrice}
                        onChange={(e) =>
                          updateEditStockItem(idx, 'retailPrice', e.target.value)
                        }
                      />
                    </label>
                    <label>
                      Wholesale ₦
                      <input
                        type="number"
                        min="0"
                        value={item.wholesalePrice}
                        onChange={(e) =>
                          updateEditStockItem(idx, 'wholesalePrice', e.target.value)
                        }
                      />
                    </label>
                    {item.isNewDrug && (
                      <>
                        <label>
                          Half Pack Qty
                          <input
                            type="number"
                            min="0"
                            value={item.halfPackQty}
                            onChange={(e) =>
                              updateEditStockItem(idx, 'halfPackQty', e.target.value)
                            }
                          />
                        </label>
                        <label>
                          Half Pack ₦
                          <input
                            type="number"
                            min="0"
                            value={item.halfPackPrice}
                            onChange={(e) =>
                              updateEditStockItem(idx, 'halfPackPrice', e.target.value)
                            }
                          />
                        </label>
                        <label>
                          Full Pack Qty
                          <input
                            type="number"
                            min="0"
                            value={item.packQty}
                            onChange={(e) =>
                              updateEditStockItem(idx, 'packQty', e.target.value)
                            }
                          />
                        </label>
                        <label>
                          Full Pack ₦
                          <input
                            type="number"
                            min="0"
                            value={item.packPrice}
                            onChange={(e) =>
                              updateEditStockItem(idx, 'packPrice', e.target.value)
                            }
                          />
                        </label>
                      </>
                    )}
                    <button
                      type="button"
                      className="permanent-delete-btn"
                      onClick={() => removeEditStockItem(idx)}
                    >
                      ✕ Remove Line
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="save-btn"
                disabled={isSavingStockEdit}
                onClick={handleSaveStockEdit}
              >
                {isSavingStockEdit ? 'Saving…' : 'Save Correction'}
              </button>

              <button
                type="button"
                className="cancel-btn"
                onClick={() => {
                  setEditingStockEntry(null);
                  setEditStockItems([]);
                }}
              >
                Cancel
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================
          RECORD SUPPLIER PAYMENT MODAL
      ======================================================== */}
      {recordingPaymentFor && (
        <div className="modal-overlay">
          <div className="modal-card">

            <h3>Record Payment — {recordingPaymentFor.supplierName}</h3>

            <p className="form-section-hint">
              Total ₦{recordingPaymentFor.totalCost.toLocaleString()} · Paid so
              far ₦{Number(recordingPaymentFor.amountPaid || 0).toLocaleString()}{' '}
              · Owed ₦
              {Math.max(
                0,
                recordingPaymentFor.totalCost - Number(recordingPaymentFor.amountPaid || 0)
              ).toLocaleString()}
            </p>

            <div>
              <label>Amount Being Paid Now (₦):</label>
              <input
                type="number"
                min="0"
                max={Math.max(
                  0,
                  recordingPaymentFor.totalCost - Number(recordingPaymentFor.amountPaid || 0)
                )}
                value={recordPaymentAmount}
                onChange={(e) => setRecordPaymentAmount(e.target.value)}
                autoFocus
              />
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="save-btn"
                disabled={isRecordingPayment}
                onClick={handleConfirmRecordPayment}
              >
                {isRecordingPayment ? 'Recording…' : 'Record Payment'}
              </button>

              <button
                type="button"
                className="cancel-btn"
                onClick={() => {
                  setRecordingPaymentFor(null);
                  setRecordPaymentAmount('');
                }}
              >
                Cancel
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================
          UNMISSABLE CONFIRM-DELETE MODAL (drugs & suppliers)
          Deletion is always a soft-delete, but there's no plain
          window.confirm() skip-through anymore — the name has to be
          read, and for a drug, a supplier's worth of context is shown
          too, so nobody deletes the wrong one by habit-clicking through.
      ======================================================== */}
      {deletingTarget && (
        <div className="modal-overlay">
          <div className="modal-card">

            <h3>
              Delete{' '}
              {deletingTarget.kind === 'drug'
                ? 'Drug'
                : deletingTarget.kind === 'customer'
                ? 'Customer'
                : 'Supplier'}
              ?
            </h3>

            <p className="form-section-hint">
              {userRole === 'cashier'
                ? "This needs a manager's approval before it takes effect — nothing disappears yet."
                : "This moves it to Recently Deleted. An administrator can restore it or remove it permanently later — it isn't gone yet, but stop and make sure this is the right one."}
            </p>

            <p>
              <strong>{deletingTarget.item?.name}</strong>
              {deletingTarget.kind === 'drug' && (
                <>
                  {' '}— Stock: {deletingTarget.item?.stock ?? 0}{' '}
                  {deletingTarget.item?.unitType || deletingTarget.item?.unit_type}
                </>
              )}
              {deletingTarget.kind === 'supplier' && deletingTarget.item?.contactPerson && (
                <> — {deletingTarget.item.contactPerson}</>
              )}
              {deletingTarget.kind === 'customer' && (
                <>
                  {' '}
                  — {deletingTarget.item?.phone || 'no phone on file'}
                  {Number(deletingTarget.item?.balance || 0) !== 0 && (
                    <>
                      {' '}
                      ·{' '}
                      {Number(deletingTarget.item.balance) > 0
                        ? `owes ₦${Number(deletingTarget.item.balance).toLocaleString()}`
                        : `owed ₦${Math.abs(Number(deletingTarget.item.balance)).toLocaleString()}`}
                    </>
                  )}
                </>
              )}
            </p>

            <div className="modal-actions">
              <button
                type="button"
                className="permanent-delete-btn"
                disabled={isDeletingTarget}
                onClick={async () => {
                  setIsDeletingTarget(true);
                  try {
                    if (deletingTarget.kind === 'drug') {
                      await handleConfirmDeleteDrug(deletingTarget.item);
                    } else if (deletingTarget.kind === 'customer') {
                      await handleConfirmDeleteCustomer(deletingTarget.item);
                    } else {
                      await handleConfirmDeleteSupplier(deletingTarget.item);
                    }
                    setDeletingTarget(null);
                  } finally {
                    setIsDeletingTarget(false);
                  }
                }}
              >
                {isDeletingTarget ? 'Deleting…' : 'Yes, Delete'}
              </button>

              <button
                type="button"
                className="cancel-btn"
                onClick={() => setDeletingTarget(null)}
              >
                Cancel
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================
          SUPPLIER ADD/EDIT MODAL
      ======================================================== */}
      {isSupplierModalOpen && (
        <div className="modal-overlay">
          <div className="modal-card">
            <form onSubmit={handleSaveSupplier}>
              <h3>{editingSupplier ? 'Edit Supplier' : 'New Supplier'}</h3>

              <label>
                Name:
                <input
                  type="text"
                  required
                  value={supplierFormData.name}
                  onChange={(e) =>
                    setSupplierFormData({ ...supplierFormData, name: e.target.value })
                  }
                />
              </label>

              <label>
                Contact Person:
                <input
                  type="text"
                  value={supplierFormData.contactPerson}
                  onChange={(e) =>
                    setSupplierFormData({ ...supplierFormData, contactPerson: e.target.value })
                  }
                />
              </label>

              <label>
                Phone:
                <input
                  type="text"
                  value={supplierFormData.phone}
                  onChange={(e) =>
                    setSupplierFormData({ ...supplierFormData, phone: e.target.value })
                  }
                />
              </label>

              <label>
                Email:
                <input
                  type="email"
                  value={supplierFormData.email}
                  onChange={(e) =>
                    setSupplierFormData({ ...supplierFormData, email: e.target.value })
                  }
                />
              </label>

              <label>
                Address:
                <textarea
                  rows={2}
                  value={supplierFormData.address}
                  onChange={(e) =>
                    setSupplierFormData({ ...supplierFormData, address: e.target.value })
                  }
                />
              </label>

              <div className="modal-actions">
                <button type="submit" className="save-btn" disabled={isSavingSupplierCrud}>
                  {isSavingSupplierCrud ? 'Saving…' : 'Save Supplier'}
                </button>
                <button
                  type="button"
                  className="cancel-btn"
                  onClick={() => setIsSupplierModalOpen(false)}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================
          WHOLESALE CUSTOMER ADD/EDIT MODAL
      ======================================================== */}
      {isCustomerModalOpen && (
        <div className="modal-overlay">
          <div className="modal-card">
            <form onSubmit={handleSaveCustomer}>
              <h3>{editingCustomer ? 'Edit Customer' : 'New Wholesale Customer'}</h3>

              <label>
                Name:
                <input
                  type="text"
                  required
                  value={customerFormData.name}
                  onChange={(e) =>
                    setCustomerFormData({ ...customerFormData, name: e.target.value })
                  }
                />
              </label>

              <label>Phone number(s):</label>
              {(customerFormData.phones && customerFormData.phones.length > 0
                ? customerFormData.phones
                : ['']
              ).map((num, idx) => (
                <div key={idx} className="form-row electronic-line">
                  <input
                    type="text"
                    placeholder={idx === 0 ? 'Primary phone' : 'Another number'}
                    value={num}
                    onChange={(e) => {
                      const next = [...(customerFormData.phones.length > 0 ? customerFormData.phones : [''])];
                      next[idx] = e.target.value;
                      setCustomerFormData({ ...customerFormData, phones: next });
                    }}
                  />
                  {customerFormData.phones.length > 1 && (
                    <button
                      type="button"
                      className="permanent-delete-btn"
                      onClick={() => {
                        const next = customerFormData.phones.filter((_, i) => i !== idx);
                        setCustomerFormData({ ...customerFormData, phones: next.length > 0 ? next : [''] });
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                className="price-rec-chip"
                onClick={() =>
                  setCustomerFormData({
                    ...customerFormData,
                    phones: [...(customerFormData.phones || []), '']
                  })
                }
              >
                + Add another number
              </button>

              <label>
                Email:
                <input
                  type="email"
                  value={customerFormData.email}
                  onChange={(e) =>
                    setCustomerFormData({ ...customerFormData, email: e.target.value })
                  }
                />
              </label>

              <label>
                Address:
                <textarea
                  rows={2}
                  value={customerFormData.address}
                  onChange={(e) =>
                    setCustomerFormData({ ...customerFormData, address: e.target.value })
                  }
                />
              </label>

              {editingCustomer && Number(editingCustomer.balance || 0) !== 0 && (
                <p className="form-section-hint">
                  Current balance:{' '}
                  {Number(editingCustomer.balance) > 0
                    ? `owes ₦${Number(editingCustomer.balance).toLocaleString()}`
                    : `pharmacy owes them ₦${Math.abs(Number(editingCustomer.balance)).toLocaleString()}`}
                  {' '}— balance only changes through a sale, not this form.
                </p>
              )}

              <div className="modal-actions">
                <button type="submit" className="save-btn" disabled={isSavingCustomerCrud}>
                  {isSavingCustomerCrud ? 'Saving…' : 'Save Customer'}
                </button>
                <button
                  type="button"
                  className="cancel-btn"
                  onClick={() => {
                    setIsCustomerModalOpen(false);
                    setCustomerPickerForDraftId(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================
          MANAGER: REJECT STOCK ENTRY CORRECTION MODAL
      ======================================================== */}
      {rejectingStockEdit && (
        <div className="modal-overlay">
          <div className="modal-card">

            <h3>Reject Correction</h3>

            <p className="form-section-hint">
              The original entry stays exactly as it was — this just tells{' '}
              {nameOf(rejectingStockEdit.requestedByEmail)} why the correction was
              turned down.
            </p>

            <div>
              <label>Reason:</label>
              <textarea
                rows={3}
                value={stockEditRejectReason}
                onChange={(e) => setStockEditRejectReason(e.target.value)}
                placeholder="e.g. Please re-check the invoice quantities before resubmitting"
              />
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="save-btn"
                disabled={isRejectingStockEdit}
                onClick={handleConfirmRejectStockEdit}
              >
                {isRejectingStockEdit ? 'Rejecting…' : 'Reject'}
              </button>

              <button
                type="button"
                className="cancel-btn"
                onClick={() => setRejectingStockEdit(null)}
              >
                Cancel
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================
          MANAGER: REJECT DRUG/SUPPLIER CHANGE REQUEST MODAL
      ======================================================== */}
      {rejectingChangeRequest && (
        <div className="modal-overlay">
          <div className="modal-card">

            <h3>
              Reject{' '}
              {rejectingChangeRequest.kind === 'drug'
                ? 'Drug'
                : rejectingChangeRequest.kind === 'customer'
                ? 'Customer'
                : 'Supplier'}{' '}
              {rejectingChangeRequest.request.type === 'DELETE'
                ? 'Deletion'
                : rejectingChangeRequest.request.type === 'CREATE'
                  ? 'Registration'
                  : 'Edit'}
            </h3>

            <p className="form-section-hint">
              Nothing changes — this tells{' '}
              {nameOf(rejectingChangeRequest.request.requestedByEmail)} why it was turned down.
            </p>

            <div>
              <label>Reason:</label>
              <textarea
                rows={3}
                value={changeRequestRejectReason}
                onChange={(e) => setChangeRequestRejectReason(e.target.value)}
                placeholder="e.g. Please double-check the new price against the invoice"
              />
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="save-btn"
                disabled={isRejectingChangeRequest}
                onClick={handleConfirmRejectChangeRequest}
              >
                {isRejectingChangeRequest ? 'Rejecting…' : 'Reject'}
              </button>

              <button
                type="button"
                className="cancel-btn"
                onClick={() => setRejectingChangeRequest(null)}
              >
                Cancel
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================
          PARTIAL SALE REVERSAL MODAL (manager)
      ======================================================== */}
      {reversingSale && (
        <div className="modal-overlay">

          <div className="modal-card">

            <h3>Reverse Items — {reversingSale.id}</h3>

            <p className="form-section-hint">
              Enter how many units of each item to reverse. Stock is
              restored and the sale total is reduced by the refunded
              amount. Leave an item at 0 to leave it untouched.
            </p>

            <div className="reversal-items-list">
              {(reversingSale.items || []).map((item) => {
                const alreadyReversed = Number(item.reversedQty) || 0;
                const maxReversible = item.quantity - alreadyReversed;

                return (
                  <div
                    key={item.id}
                    className="reversal-item-row"
                  >
                    <div>
                      <strong>{item.name}</strong>
                      <div className="reversal-item-meta">
                        Sold: {item.quantity} {item.unitType}
                        {alreadyReversed > 0 &&
                          ` · Already reversed: ${alreadyReversed}`}
                        {maxReversible <= 0 && ' · Fully reversed'}
                      </div>
                    </div>

                    <input
                      type="number"
                      min="0"
                      max={maxReversible}
                      disabled={maxReversible <= 0}
                      placeholder="0"
                      value={reversalQtys[item.id] || ''}
                      onChange={(e) => {
                        const val = Math.max(
                          0,
                          Math.min(
                            maxReversible,
                            Number(e.target.value) || 0
                          )
                        );
                        setReversalQtys({
                          ...reversalQtys,
                          [item.id]: val
                        });
                      }}
                    />
                  </div>
                );
              })}
            </div>

            <div className="modal-actions">
              <button
                type="button"
                className="save-btn"
                disabled={isReversing}
                onClick={handleConfirmReversal}
              >
                {isReversing ? 'Reversing…' : 'Confirm Reversal'}
              </button>

              <button
                type="button"
                className="cancel-btn"
                onClick={() => {
                  setReversingSale(null);
                  setReversalQtys({});
                }}
              >
                Cancel
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ========================================================
          ADD / EDIT DRUG MODAL
      ======================================================== */}
      {isModalOpen &&
        hasRole(userRole, 'manager') && (
          <div className="modal-overlay">

            <div className="modal-card">

              <h3>
                {editingDrug
                  ? 'Edit Drug Details'
                  : 'Add New Drug'}
              </h3>

              <form
                onSubmit={
                  handleSaveDrug
                }
                className="crud-form"
              >

                <label>
                  Drug Name:
                </label>

                <input
                  type="text"
                  required
                  value={
                    formData.name
                  }
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      name: e.target.value
                    })
                  }
                />

                <label>
                  Unit Type:
                </label>

                <select
                  value={
                    formData.unitType
                  }
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      unitType:
                        e.target.value
                    })
                  }
                >
                  <option value="Sachet">
                    Sachet
                  </option>

                  <option value="Bottle">
                    Bottle
                  </option>

                  <option value="Tube">
                    Tube
                  </option>

                  <option value="Ampoule">
                    Ampoule
                  </option>

                  <option value="Drop">
                    Drop
                  </option>

                  <option value="Vial">
                    Vial
                  </option>

                  <option value="Strip">
                    Strip
                  </option>

                  <option value="Unit">
                    Unit
                  </option>
                </select>

                <div className="form-row">

                  <div>
                    <label>
                      Cost Price (₦):
                    </label>

                    <input
                      type="number"
                      required
                      value={
                        formData.costPrice
                      }
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          costPrice:
                            e.target.value
                        })
                      }
                    />
                  </div>

                  <div>
                    <label>
                      Retail Price (₦):
                    </label>

                    <input
                      type="number"
                      required
                      value={
                        formData.retailPrice
                      }
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          retailPrice:
                            e.target.value
                        })
                      }
                    />
                  </div>

                </div>

                <PriceRecommendationHint
                  costPrice={formData.costPrice}
                  priceHistory={editingDrug?.priceHistory}
                  settings={pricingSettings}
                  onPickRetail={(price) =>
                    setFormData((prev) => ({ ...prev, retailPrice: String(price) }))
                  }
                  onPickWholesale={(price) =>
                    setFormData((prev) => ({ ...prev, wholesalePrice: String(price) }))
                  }
                />

                <div className="form-row">

                  <div>
                    <label>
                      Wholesale Price (₦):
                    </label>

                    <input
                      type="number"
                      required
                      value={
                        formData.wholesalePrice
                      }
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          wholesalePrice:
                            e.target.value
                        })
                      }
                    />
                  </div>

                  <div>
                    <label>
                      Stock Qty:
                    </label>

                    <input
                      type="number"
                      required
                      value={
                        formData.stock
                      }
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          stock:
                            e.target.value
                        })
                      }
                    />
                  </div>

                </div>

                <label>
                  Barcode (Optional):
                </label>

                <input
                  type="text"
                  value={
                    formData.barcode
                  }
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      barcode:
                        e.target.value
                    })
                  }
                />

                <p className="form-section-hint">
                  Pack Discounts (Optional) — leave blank for drugs that are only sold one {formData.unitType.toLowerCase()} at a time.
                </p>

                <div className="form-row">

                  <div>
                    <label>
                      Half Pack Qty:
                    </label>

                    <input
                      type="number"
                      min="0"
                      placeholder="e.g. 6"
                      value={
                        formData.halfPackQty
                      }
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          halfPackQty:
                            e.target.value
                        })
                      }
                    />
                  </div>

                  <div>
                    <label>
                      Half Pack Price (₦):
                    </label>

                    <input
                      type="number"
                      min="0"
                      placeholder="e.g. 1000"
                      value={
                        formData.halfPackPrice
                      }
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          halfPackPrice:
                            e.target.value
                        })
                      }
                    />
                  </div>

                </div>

                <div className="form-row">

                  <div>
                    <label>
                      Full Pack Qty:
                    </label>

                    <input
                      type="number"
                      min="0"
                      placeholder="e.g. 12"
                      value={
                        formData.packQty
                      }
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          packQty:
                            e.target.value
                        })
                      }
                    />
                  </div>

                  <div>
                    <label>
                      Full Pack Price (₦):
                    </label>

                    <input
                      type="number"
                      min="0"
                      placeholder="e.g. 2000"
                      value={
                        formData.packPrice
                      }
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          packPrice:
                            e.target.value
                        })
                      }
                    />
                  </div>

                </div>

                <p className="form-section-hint">
                  Restock Planning (Optional) — used for the automated
                  purchase list, not required to save this drug.
                </p>

                <div className="form-row">
                  <div>
                    <label>Standard Minimum Quantity:</label>
                    <input
                      type="number"
                      min="0"
                      placeholder="e.g. 20"
                      value={formData.minStockQty}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          minStockQty: e.target.value
                        })
                      }
                    />
                  </div>

                  <div>
                    <label>Recommended Purchase Quantity:</label>
                    <input
                      type="number"
                      min="0"
                      placeholder="e.g. 50"
                      value={formData.recommendedPurchaseQty}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          recommendedPurchaseQty: e.target.value
                        })
                      }
                    />
                  </div>

                  <div>
                    <label>Space on the Counter:</label>
                    <input
                      type="text"
                      placeholder="e.g. Shelf A2, Fridge, Drawer 3"
                      value={formData.counterSpace || ''}
                      onChange={(e) =>
                        setFormData({
                          ...formData,
                          counterSpace: e.target.value
                        })
                      }
                    />
                  </div>

                </div>

                <div className="modal-actions">

                  <button
                    type="submit"
                    className="save-btn"
                    disabled={isSavingDrug}
                  >
                    {isSavingDrug ? 'Saving…' : 'Save Changes'}
                  </button>

                  <button
                    type="button"
                    className="cancel-btn"
                    onClick={() =>
                      setIsModalOpen(
                        false
                      )
                    }
                  >
                    Cancel
                  </button>

                </div>

              </form>

            </div>
          </div>
        )}
    </div>
  );
}