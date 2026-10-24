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
  createTicket,
  fetchCloudTickets,
  syncPendingTicketsToCloud,
  expireStaleTickets,
  cancelTicket,
  approveTicket,
  fetchBankOptions,
  addBankOption,
  removeBankOption,
  syncPendingBankOptionsToCloud,
  logAuditEvent
} from './db';
import './App.css';

const LAST_SEEN_AUDIT_KEY = 'azu_last_seen_manager_changes';

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
    packPrice: ''
  });

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
  const [lastSeenAuditAt, setLastSeenAuditAt] = useState(
    () => localStorage.getItem(LAST_SEEN_AUDIT_KEY) || null
  );

  // Drug-sale accountability search: "who sold this and when" for a
  // named drug, independent of the Sales History tab's own filters.
  const [drugSearchTerm, setDrugSearchTerm] = useState('');

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

  // Cashier-side: which PENDING_PAYMENT ticket is open in the
  // approve/payment-split modal, and the cash/bank/card amounts and
  // chosen bank being entered for it.
  const [approvingTicket, setApprovingTicket] = useState(null);
  const [paymentCash, setPaymentCash] = useState('');
  const [paymentBank, setPaymentBank] = useState('');
  const [paymentCard, setPaymentCard] = useState('');
  const [paymentBankOption, setPaymentBankOption] = useState('');
  const [isApprovingTicket, setIsApprovingTicket] = useState(false);

  // Admin: new bank-option name being typed into the add box.
  const [newBankOptionName, setNewBankOptionName] = useState('');

  // The just-submitted ticket shown in the printable "take this to the
  // cashier" slip modal (separate from the receipt modal, which is only
  // for a completed/PAID sale).
  const [printingTicket, setPrintingTicket] = useState(null);

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

  // ============================================================
  // SUPABASE AUTH
  // ============================================================
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);

      if (session) {
        fetchUserProfile(session.user.id);
      }
    });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, session) => {
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

        if (!hasRole(userRole, 'manager')) {
          query = query.eq('cashier_id', session.user.id);
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
          customerName:
            s.customer_name || s.customerName || 'Walk-in Customer',
          customerPhone: s.customer_phone || s.customerPhone || 'N/A',
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

      syncAuditLogToCloud();
      fetchCloudAuditLog();

      syncPendingTicketsToCloud().then(() => {
        fetchCloudTickets();
      });

      syncPendingBankOptionsToCloud().then(() => {
        fetchBankOptions();
      });

      expireStaleTickets();

      pruneSalesOlderThanOneYear();
    };

    const handleOnline = () => {
      setIsOnline(true);
      runAllSync();
    };

    const handleOffline = () => {
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

  // A pure cashier account has no POS tab (see the nav above) — if their
  // role loads in after the default 'pos' tab is already selected (or
  // they were switched to cashier while the app was open), bounce them
  // straight to their Queue instead of showing an empty/inaccessible tab.
  useEffect(() => {
    if (userRole === 'cashier' && activeTab === 'pos') {
      setActiveTab('tickets');
    }
  }, [userRole, activeTab]);

  useEffect(() => {
    if (activeTab === 'history' && isOnline) {
      fetchCloudSales();
    }

    // Tickets need to feel close to real-time — a customer is standing
    // at the till waiting — so re-pull from the cloud every 10s while
    // either the attendant's POS screen (ticket drafts + "my tickets")
    // or the cashier's Queue screen is open, on top of the
    // reconnect/tab-switch fetch.
    if ((activeTab === 'pos' || activeTab === 'tickets') && isOnline) {
      fetchCloudTickets();
      expireStaleTickets();

      const interval = setInterval(() => {
        fetchCloudTickets();
        expireStaleTickets();
      }, 10000);

      return () => clearInterval(interval);
    }
  }, [activeTab, isOnline]);

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
            return Boolean(nameMatch || barcodeMatch);
          })
          .toArray();

    return all.filter((drug) => !drug.deletedAt);
  }, [searchTerm]);

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

  // What the CASHIER queue shows: every attendant's submitted tickets
  // still awaiting payment, oldest first so nobody waits out of turn.
  const pendingTickets = React.useMemo(() => {
    if (!allTickets) return [];
    return allTickets
      .filter((t) => t.status === 'PENDING_PAYMENT')
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }, [allTickets]);

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
    if (!hasRole(userRole, 'cashier')) return;

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
        t.attendantEmail === session.user.email
    );
  }, [allTickets, session]);

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

    if (!hasRole(userRole, 'manager')) {
      records = records.filter(
        (s) =>
          s.cashierId === session.user.id ||
          s.cashierEmail === session.user.email
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
  // PARTIAL SALE REVERSAL (manager feature)
  // reversalQtys is keyed by item id → how many units of that line the
  // manager wants to reverse right now (never more than quantity minus
  // whatever was already reversed earlier).
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

        setReversingSale(null);
        setReversalQtys({});
      } else {
        alert(result.reason || 'Unable to reverse those items.');
      }
    } finally {
      setIsReversing(false);
    }
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
      lineTotal: computePackPricing(item).total
    }));

  // ============================================================
  // TICKET DRAFTS (attendant building carts for the cashier workflow)
  // Each draft is an isolated cart — its own items/customer/saleType —
  // so several customers can be worked on at once. Nothing here is
  // persisted until handleSubmitTicket runs.
  // ============================================================
  const createNewDraft = () => {
    const draftId = `draft-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    setTicketDrafts((prev) => [
      ...prev,
      {
        id: draftId,
        items: [],
        customerName: '',
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

  const addToDraft = (draftId, drug) => {
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

    setIsSubmittingTicket(true);

    try {
      const ticketPayload = {
        items: slimCartItems(draft.items),
        total: draftTotal(draft),
        saleType: draft.saleType,
        customerName: draft.customerName.trim() || 'Walk-in Customer',
        customerPhone: draft.customerPhone.trim() || 'N/A',
        attendantId: session?.user?.id,
        attendantEmail: session?.user?.email
      };

      const result = await createTicket(ticketPayload, {
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
    setPaymentCash('');
    setPaymentBank('');
    setPaymentCard('');
    setPaymentBankOption(bankOptions?.[0]?.name || '');
  };

  const handleConfirmApproval = async () => {
    if (!approvingTicket) return;

    const cash = Number(paymentCash) || 0;
    const bank = Number(paymentBank) || 0;
    const card = Number(paymentCard) || 0;
    const sum = cash + bank + card;

    // Allow a 1-naira tolerance for rounding, not more — a payment
    // short or over the ticket total is exactly the kind of mistake
    // this split-role workflow exists to catch before it leaves the
    // till.
    if (Math.abs(sum - approvingTicket.total) > 1) {
      alert(
        `Payment entered (₦${sum.toLocaleString()}) doesn't match the ticket total (₦${approvingTicket.total.toLocaleString()}). Adjust the cash/bank/card amounts so they add up exactly.`
      );
      return;
    }

    if (bank > 0 && !paymentBankOption) {
      alert('Select which bank the transfer was made to.');
      return;
    }

    setIsApprovingTicket(true);

    try {
      const paymentBreakdown = {
        cash,
        bank,
        bankOption: bank > 0 ? paymentBankOption : null,
        card
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
  // ADMIN: BANK OPTIONS
  // ============================================================
  const handleAddBankOption = async () => {
    const name = newBankOptionName.trim();
    if (!name) return;

    await addBankOption(name, {
      email: session?.user?.email,
      role: userRole
    });

    setNewBankOptionName('');
  };

  const handleRemoveBankOption = async (option) => {
    if (!window.confirm(`Remove "${option.name}" from the bank list?`)) return;

    await removeBankOption(option.id, {
      email: session?.user?.email,
      role: userRole
    });
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
                // Allowed to go negative on purpose — a sale can be
                // recorded before a delivery is logged, or stock counts
                // can run behind reality; clamping to 0 used to hide
                // that discrepancy instead of surfacing it.
                const newStock =
                  (existingDrug.stock || 0) -
                  item.quantity;

                await db.drugs.update(
                  existingDrug.id,
                  {
                    stock: newStock
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
          await supabase
            .from('drugs')
            .update({ stock: updatedDrug.stock })
            .eq('id', updatedDrug.id);
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
      packPrice: ''
    });

    setIsModalOpen(true);
  };

  const handleOpenEditModal = (drug, e) => {
    e.stopPropagation();

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
        ''
    });

    setIsModalOpen(true);
  };

  // A manager's delete is now a SOFT delete — the drug moves to the
  // administrator's "Recently Deleted" list instead of disappearing
  // for good. Only an administrator can remove it permanently.
  const handleDeleteDrug = async (id, e) => {
    e.stopPropagation();

    if (
      window.confirm(
        'Move this drug to Recently Deleted? An administrator can restore it or remove it permanently later.'
      )
    ) {
      await softDeleteDrug(id, {
        email: session?.user?.email,
        role: userRole
      });
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
      pack_price: drugPayload.packPrice
    };

    const { error: upsertError } = await supabase
      .from('drugs')
      .upsert([cloudPayload]);

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
        stock: Number(formData.stock),
        barcode: formData.barcode,
        halfPackQty: optionalNumber(formData.halfPackQty),
        halfPackPrice: optionalNumber(formData.halfPackPrice),
        packQty: optionalNumber(formData.packQty),
        packPrice: optionalNumber(formData.packPrice),
        synced: 0
      };

      if (editingDrug) {
        await db.drugs.update(editingDrug.id, drugPayload);
      } else {
        await db.drugs.add(drugPayload);
      }

      // The local write is done — close the form immediately instead
      // of making the user wait on the network. This also removes the
      // Save button from the screen, so there's nothing left to
      // double-click even if someone tries.
      const wasEditing = Boolean(editingDrug);
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
  if (!session) {
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
            <span className="user-email">
              {session?.user?.email}
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
          <h1>
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
                so the POS tab doesn't exist for that role. Managers and
                administrators outrank cashier, so they still get it. */}
            {userRole !== 'cashier' && (
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

            {/* The approval Queue is only for cashier rank and above —
                a plain salesperson/attendant builds tickets from the
                POS tab instead and never approves payment. */}
            {hasRole(userRole, 'cashier') && (
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

          {activeTab === 'pos' && (
            <div className="price-mode-toggle">
              <button
                className={
                  saleType === 'retail'
                    ? 'active'
                    : ''
                }
                onClick={() =>
                  handleSaleTypeChange(
                    'retail'
                  )
                }
              >
                Retail
              </button>

              <button
                className={
                  saleType === 'wholesale'
                    ? 'active'
                    : ''
                }
                onClick={() =>
                  handleSaleTypeChange(
                    'wholesale'
                  )
                }
              >
                Wholesale
              </button>
            </div>
          )}

          {activeTab === 'pos' &&
            hasRole(userRole, 'manager') && (
              <button
                className="add-drug-btn"
                onClick={
                  handleOpenAddModal
                }
              >
                + Add Drug
              </button>
            )}
        </div>

        {activeTab === 'pos' && (
          <div className="search-row">
            <input
              type="text"
              className="search-input"
              placeholder="Search drug name or barcode..."
              value={searchTerm}
              onChange={(e) =>
                setSearchTerm(
                  e.target.value
                )
              }
              autoFocus
            />
          </div>
        )}
      </header>

      {/* ========================================================
          POS TERMINAL
      ======================================================== */}
      {activeTab === 'pos' && (
        <div className="tickets-screen no-print">

          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Build Tickets</h3>
              <span className="admin-section-sub">
                Build a cart for each customer, submit it, and hand them the
                printed ticket to carry to the cashier. You can keep several
                customers' tickets open at once.
              </span>
            </div>

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
            </div>

            {activeDraft ? (
              <div className="ticket-draft-builder">
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

                <div className="price-mode-toggle">
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

                            {hasRole(userRole, 'manager') && (
                              <div className="manager-actions">
                                <button
                                  onClick={(e) => handleOpenEditModal(drug, e)}
                                >
                                  ✏️ Edit
                                </button>

                                <button
                                  onClick={(e) => handleDeleteDrug(drug.id, e)}
                                  className="del-btn"
                                  title="Move to Recently Deleted"
                                >
                                  🗑️
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="empty-state">No drugs found.</div>
                  )}
                </div>

                <div className="cart-items-list ticket-items-list">
                  {activeDraft.items.length > 0 ? (
                    activeDraft.items.map((item) => {
                      const pricing = computePackPricing(item);
                      return (
                        <div key={item.id} className="cart-item">
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
                      🛒 Tap a drug above to add it to this ticket
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
                      <strong>{t.customerName}</strong>
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
      {activeTab === 'history' && (
        <div className="history-screen no-print">

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
                      {email}
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
                      💳{' '}
                      <strong>
                        Cashier:
                      </strong>{' '}
                      {sale.cashierEmail}
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
      {activeTab === 'tickets' && (
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
                  <div key={t.id} className="ticket-row">
                    <div>
                      <strong>{t.customerName}</strong>
                      <div className="deleted-drug-meta">
                        {t.items.map((i) => `${i.name} x${i.quantity}`).join(', ')}
                        {' · '}₦{t.total.toLocaleString()} · by {t.attendantEmail}
                      </div>
                    </div>

                    <div className="deleted-drug-actions">
                      <button
                        className="restore-btn"
                        onClick={() => handleOpenApproveModal(t)}
                      >
                        💳 Approve Payment
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
          ADMINISTRATOR SCREEN
      ======================================================== */}
      {activeTab === 'admin' && hasRole(userRole, 'administrator') && (
        <div className="admin-screen no-print">

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
                          👤 Sold by: <strong>{match.cashierEmail}</strong>
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
                        Deleted by {drug.deletedBy || 'unknown'} on{' '}
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
              <button className="save-btn" onClick={handleAddBankOption}>
                + Add Bank
              </button>
            </div>

            {bankOptions && bankOptions.length > 0 ? (
              <div className="deleted-drug-list">
                {bankOptions.map((option) => (
                  <div key={option.id} className="deleted-drug-card">
                    <div className="deleted-drug-info">
                      <strong>{option.name}</strong>
                    </div>
                    <div className="deleted-drug-actions">
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

          <section className="admin-section">
            <div className="admin-section-header">
              <h3>Audit Log</h3>
              <span className="admin-section-sub">
                Every sensitive action taken by managers and administrators
              </span>
            </div>

            {auditLog && auditLog.length > 0 ? (
              <div className="audit-log-list">
                {auditLog.map((entry) => (
                  <div key={entry.id} className="audit-log-entry">
                    <div className="audit-log-main">
                      <strong>{entry.action.replace(/_/g, ' ')}</strong>
                      <span className="audit-log-meta">
                        {entry.actorEmail} ({entry.actorRole}) ·{' '}
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
              <div className="empty-state">No audit log entries yet.</div>
            )}
          </section>

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
                  Sales Receipt (
                  {saleSuccessData.saleType.toUpperCase()}
                  )
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
                    saleSuccessData.cashierEmail
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
                  TOTAL PAID:
                </strong>

                <strong>
                  ₦
                  {saleSuccessData.total.toLocaleString()}
                </strong>

              </div>

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
          CASHIER: APPROVE PAYMENT MODAL
      ======================================================== */}
      {approvingTicket && (
        <div className="modal-overlay">
          <div className="modal-card">

            <h3>Approve Payment — {approvingTicket.customerName}</h3>

            <p className="form-section-hint">
              Total Due: ₦{approvingTicket.total.toLocaleString()}. Enter how
              much was paid by each method — cash, bank and card amounts must
              add up to the total exactly (splitting across methods is fine).
            </p>

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

              <div>
                <label>Card (₦):</label>
                <input
                  type="number"
                  min="0"
                  value={paymentCard}
                  onChange={(e) => setPaymentCard(e.target.value)}
                />
              </div>
            </div>

            <div className="form-row">
              <div>
                <label>Bank Transfer (₦):</label>
                <input
                  type="number"
                  min="0"
                  value={paymentBank}
                  onChange={(e) => setPaymentBank(e.target.value)}
                />
              </div>

              <div>
                <label>Bank:</label>
                <select
                  value={paymentBankOption}
                  onChange={(e) => setPaymentBankOption(e.target.value)}
                >
                  <option value="">Select bank…</option>
                  {(bankOptions || []).map((b) => (
                    <option key={b.id} value={b.name}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

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