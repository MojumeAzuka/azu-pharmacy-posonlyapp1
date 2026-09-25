import React, { useState, useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  db,
  supabase,
  hasRole,
  syncDrugsFromCloud,
  syncPendingSalesToCloud,
  syncAuditLogToCloud,
  pruneSalesOlderThanOneYear,
  softDeleteDrug,
  restoreDrug,
  permanentlyDeleteDrug,
  bulkDeleteSalesByDateRange,
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

  const [formData, setFormData] = useState({
    name: '',
    unitType: 'Sachet',
    costPrice: '',
    retailPrice: '',
    wholesalePrice: '',
    stock: '',
    barcode: ''
  });

  // ============================================================
  // SALES HISTORY
  // ============================================================
  const [historySearchTerm, setHistorySearchTerm] = useState('');
  const [historyCashierFilter, setHistoryCashierFilter] = useState('all');
  const [cloudSales, setCloudSales] = useState([]);

  // ============================================================
  // ADMINISTRATOR STATE
  // ============================================================
  const [bulkDeleteStart, setBulkDeleteStart] = useState('');
  const [bulkDeleteEnd, setBulkDeleteEnd] = useState('');
  const [lastSeenAuditAt, setLastSeenAuditAt] = useState(
    () => localStorage.getItem(LAST_SEEN_AUDIT_KEY) || null
  );

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
  const fetchCloudSales = async () => {
    if (!navigator.onLine || !session) return;

    try {
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

      let query = supabase
        .from('sales')
        .select('*')
        .gte('created_at', oneYearAgo.toISOString())
        .order('created_at', { ascending: false });

      if (!hasRole(userRole, 'manager')) {
        query = query.eq('cashier_id', session.user.id);
      }

      const { data, error } = await query;

      if (error) throw error;

      if (data) {
        const formatted = data.map((s) => ({
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
    const handleOnline = () => {
      setIsOnline(true);

      syncDrugsFromCloud();

      syncPendingSalesToCloud().then(() => {
        fetchCloudSales();
      });

      syncAuditLogToCloud();

      pruneSalesOlderThanOneYear();
    };

    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    if (navigator.onLine) {
      syncDrugsFromCloud();

      syncPendingSalesToCloud().then(() => {
        fetchCloudSales();
      });

      syncAuditLogToCloud();

      pruneSalesOlderThanOneYear();
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [session, userRole]);

  useEffect(() => {
    if (activeTab === 'history' && isOnline) {
      fetchCloudSales();
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
  };

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

  const cartTotal = cart.reduce(
    (sum, item) =>
      sum +
      (item.activePrice || 0) *
        item.quantity,
    0
  );

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
        items: [...cart],
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
                const newStock = Math.max(
                  0,
                  (existingDrug.stock || 0) -
                    item.quantity
                );

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
      unitType: 'Sachet',
      costPrice: '',
      retailPrice: '',
      wholesalePrice: '',
      stock: '',
      barcode: ''
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
      barcode: drug.barcode || ''
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

  const handleSaveDrug = async (e) => {
    e.preventDefault();

    const drugId = editingDrug
      ? String(editingDrug.id)
      : Date.now().toString();

    const drugPayload = {
      id: drugId,
      name: formData.name,
      unitType: formData.unitType,
      costPrice: Number(
        formData.costPrice
      ),
      retailPrice: Number(
        formData.retailPrice
      ),
      wholesalePrice: Number(
        formData.wholesalePrice
      ),
      stock: Number(formData.stock),
      barcode: formData.barcode
    };

    if (editingDrug) {
      await db.drugs.update(
        editingDrug.id,
        drugPayload
      );
    } else {
      await db.drugs.add(
        drugPayload
      );
    }

    if (isOnline) {
      const cloudPayload = {
        id: drugId,
        name: formData.name,
        unit_type: formData.unitType,
        cost_price: Number(
          formData.costPrice
        ),
        retail_price: Number(
          formData.retailPrice
        ),
        wholesale_price: Number(
          formData.wholesalePrice
        ),
        stock: Number(formData.stock),
        barcode: formData.barcode
      };

      await supabase
        .from('drugs')
        .upsert([
          cloudPayload
        ]);
    }

    await logAuditEvent({
      actorEmail: session?.user?.email,
      actorRole: userRole,
      action: editingDrug ? 'drug_updated' : 'drug_added',
      targetType: 'drug',
      targetId: drugId,
      details: { name: formData.name }
    });

    setIsModalOpen(false);
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
        <div
          className={`pos-screen ${
            cart.length > 0
              ? 'cart-active'
              : 'cart-empty'
          }`}
        >

          {/* DRUG CATALOG */}
          <div className="pos-catalog-section">
            <div className="drug-list">

              {drugs &&
              drugs.length > 0 ? (
                drugs.map((drug) => {
                  const cost = Number(
                    drug.costPrice ??
                      drug.cost_price ??
                      0
                  );

                  const retail = Number(
                    drug.retailPrice ??
                      drug.retail_price ??
                      0
                  );

                  const wholesale =
                    Number(
                      drug.wholesalePrice ??
                        drug.wholesale_price ??
                        0
                    );

                  const unit =
                    drug.unitType ||
                    drug.unit_type ||
                    'Sachet';

                  return (
                    <div
                      key={drug.id}
                      className="drug-card"
                      onClick={() =>
                        addToCart(drug)
                      }
                    >

                      <div className="drug-info">
                        <div className="drug-name">
                          {drug.name}
                        </div>

                        <div className="tags-row">
                          <span className="unit-tag">
                            {unit}
                          </span>

                          <span
                            className={`stock-tag ${
                              drug.stock < 10
                                ? 'low-stock'
                                : ''
                            }`}
                          >
                            Stock:{' '}
                            {drug.stock}
                          </span>
                        </div>
                      </div>

                      <div className="price-stack">

                        {hasRole(userRole, 'manager') && (
                          <div className="price-item cost-price">
                            <small>
                              Cost:
                            </small>{' '}
                            ₦
                            {cost.toLocaleString()}
                          </div>
                        )}

                        <div
                          className={`price-item ${
                            saleType ===
                            'retail'
                              ? 'highlight'
                              : ''
                          }`}
                        >
                          <small>
                            Retail:
                          </small>{' '}
                          ₦
                          {retail.toLocaleString()}
                        </div>

                        <div
                          className={`price-item ${
                            saleType ===
                            'wholesale'
                              ? 'highlight'
                              : ''
                          }`}
                        >
                          <small>
                            Wholesale:
                          </small>{' '}
                          ₦
                          {wholesale.toLocaleString()}
                        </div>

                        {hasRole(userRole, 'manager') && (
                          <div className="manager-actions">

                            <button
                              onClick={(e) =>
                                handleOpenEditModal(
                                  drug,
                                  e
                                )
                              }
                            >
                              ✏️ Edit
                            </button>

                            <button
                              onClick={(e) =>
                                handleDeleteDrug(
                                  drug.id,
                                  e
                                )
                              }
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
                <div className="empty-state">
                  No drugs found.
                </div>
              )}

            </div>
          </div>

          {/* ====================================================
              CART
          ==================================================== */}
          <div className="cart-sidebar-wrapper">

            <div
              className={`cart-drawer ${
                cart.length === 0
                  ? 'empty-cart-drawer'
                  : ''
              }`}
            >

              <div className="cart-header">

                <h3>
                  Cart
                  <span className="cart-mode-label">
                    {' '}
                    ·{' '}
                    {saleType.toUpperCase()}
                  </span>
                </h3>

                {cart.length > 0 && (
                  <button
                    className="clear-cart-btn"
                    onClick={() =>
                      setCart([])
                    }
                  >
                    Clear
                  </button>
                )}

              </div>

              {cart.length > 0 ? (
                <>

                  <div className="customer-info-section">
                    <div className="customer-input-row">

                      <input
                        type="text"
                        placeholder="Customer name"
                        value={
                          customerName
                        }
                        onChange={(e) =>
                          setCustomerName(
                            e.target.value
                          )
                        }
                      />

                      <input
                        type="tel"
                        placeholder="Phone"
                        value={
                          customerPhone
                        }
                        onChange={(e) =>
                          setCustomerPhone(
                            e.target.value
                          )
                        }
                      />

                    </div>
                  </div>

                  <div
                    className="cart-items-list"
                    ref={cartListRef}
                  >
                    {cart.map((item) => (
                      <div
                        key={item.id}
                        className="cart-item"
                      >

                        <div className="cart-item-info">

                          <strong className="cart-item-name">
                            {item.name}
                          </strong>

                          <div className="unit-price">
                            ₦
                            {(
                              item.activePrice ||
                              0
                            ).toLocaleString()}{' '}
                            /{' '}
                            {item.unitType ||
                              item.unit_type}
                          </div>

                        </div>

                        <div className="qty-controls">

                          <button
                            onClick={() =>
                              updateQuantity(
                                item.id,
                                -1
                              )
                            }
                            aria-label="Decrease quantity"
                          >
                            -
                          </button>

                          <span>
                            {item.quantity}
                          </span>

                          <button
                            onClick={() =>
                              updateQuantity(
                                item.id,
                                1
                              )
                            }
                            aria-label="Increase quantity"
                          >
                            +
                          </button>

                        </div>

                      </div>
                    ))}
                  </div>

                  <div className="cart-summary">

                    <div className="total-display">
                      <span>
                        Total Due
                      </span>

                      <strong>
                        ₦
                        {cartTotal.toLocaleString()}
                      </strong>
                    </div>

                    <button
                      className="checkout-btn"
                      onClick={
                        handleCheckout
                      }
                    >
                      Complete Sale
                    </button>

                  </div>

                </>
              ) : (
                <div className="empty-cart-message">
                  🛒 Tap a drug to add it
                </div>
              )}

            </div>
          </div>

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
                            </span>

                            <span>
                              ₦
                              {(
                                (item.activePrice ||
                                  0) *
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
          ADMINISTRATOR SCREEN
      ======================================================== */}
      {activeTab === 'admin' && hasRole(userRole, 'administrator') && (
        <div className="admin-screen no-print">

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
                  AZU PHARMACY
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
                          (item.activePrice ||
                            0) *
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

                  <option value="Pack">
                    Pack
                  </option>

                  <option value="Bottle">
                    Bottle
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

                <div className="modal-actions">

                  <button
                    type="submit"
                    className="save-btn"
                  >
                    Save Changes
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