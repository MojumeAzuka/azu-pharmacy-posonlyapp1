import React, { useState, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, supabase, syncDrugsFromCloud, syncPendingSalesToCloud, pruneSalesOlderThanOneYear } from './db';
import './App.css';

export default function App() {
  // Auth State
  const [session, setSession] = useState(null);
  const [userRole, setUserRole] = useState('salesperson'); // 'salesperson' or 'manager'
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState('');

  // Navigation View State
  const [activeTab, setActiveTab] = useState('pos'); // 'pos' | 'history'

  // POS State
  const [searchTerm, setSearchTerm] = useState('');
  const [cart, setCart] = useState([]);
  const [saleType, setSaleType] = useState('retail');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  
  // Sale Confirmation Modal State
  const [saleSuccessData, setSaleSuccessData] = useState(null);
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // Manager CRUD Modal
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

  // Sales History Filter & Cloud Sync State
  const [historySearchTerm, setHistorySearchTerm] = useState('');
  const [historyCashierFilter, setHistoryCashierFilter] = useState('all');
  const [cloudSales, setCloudSales] = useState([]);

  // Handle Supabase Auth Session
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) fetchUserProfile(session.user.id);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) fetchUserProfile(session.user.id);
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
      if (data && data.role) {
        setUserRole(data.role);
      }
    } catch (err) {
      console.warn('Could not fetch user profile role, defaulting to salesperson:', err.message);
      setUserRole('salesperson');
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    setAuthError('');
    const { error } = await supabase.auth.signInWithPassword({
      email: loginEmail,
      password: loginPassword,
    });
    if (error) setAuthError(error.message);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setCart([]);
    setSession(null);
  };

  // Fetch Central Sales History directly from Supabase for cross-device visibility
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

      if (userRole !== 'manager') {
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
          customerName: s.customer_name || s.customerName || 'Walk-in Customer',
          customerPhone: s.customer_phone || s.customerPhone || 'N/A',
          createdAt: s.created_at || s.createdAt,
          items: typeof s.items === 'string' ? JSON.parse(s.items) : (s.items || []),
          synced: 1
        }));
        setCloudSales(formatted);
      }
    } catch (err) {
      console.warn('Cloud sales fetch deferred:', err.message);
    }
  };

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      syncDrugsFromCloud();
      syncPendingSalesToCloud().then(() => fetchCloudSales());
      pruneSalesOlderThanOneYear();
    };
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    if (navigator.onLine) {
      syncDrugsFromCloud();
      syncPendingSalesToCloud().then(() => fetchCloudSales());
      pruneSalesOlderThanOneYear();
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [session, userRole]);

  // Refetch cloud sales when entering History tab
  useEffect(() => {
    if (activeTab === 'history' && isOnline) {
      fetchCloudSales();
    }
  }, [activeTab, isOnline]);

  // Live Query for Drugs Inventory
  const drugs = useLiveQuery(async () => {
    if (!searchTerm.trim()) {
      return db.drugs.toArray();
    }
    return db.drugs
      .filter((drug) => drug.name.toLowerCase().includes(searchTerm.toLowerCase()))
      .toArray();
  }, [searchTerm]);

  // Query Local Dexie Sales
  const localSales = useLiveQuery(async () => {
    if (!session) return [];
    let records = await db.sales.orderBy('createdAt').reverse().toArray();

    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    records = records.filter(s => new Date(s.createdAt) >= oneYearAgo);

    if (userRole !== 'manager') {
      records = records.filter(
        (s) => s.cashierId === session.user.id || s.cashierEmail === session.user.email
      );
    }
    return records;
  }, [session, userRole]);

  // Merge Local (Offline/Pending) & Cloud Sales into unified history
  const salesHistory = React.useMemo(() => {
    const combinedMap = new Map();

    // Add Cloud sales first
    cloudSales.forEach((s) => combinedMap.set(String(s.id), s));

    // Overlay Local sales (overwrites cloud if pending/matching)
    (localSales || []).forEach((s) => combinedMap.set(String(s.id), s));

    let records = Array.from(combinedMap.values());

    // Sort newest first
    records.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Manager Cashier Filter
    if (userRole === 'manager' && historyCashierFilter !== 'all') {
      records = records.filter((s) => s.cashierEmail === historyCashierFilter);
    }

    // Search filter: Customer Name, Phone, or Receipt ID
    if (historySearchTerm.trim()) {
      const term = historySearchTerm.toLowerCase();
      records = records.filter(
        (s) =>
          (s.customerName && s.customerName.toLowerCase().includes(term)) ||
          (s.customerPhone && s.customerPhone.includes(term)) ||
          (s.id && String(s.id).toLowerCase().includes(term))
      );
    }

    return records;
  }, [localSales, cloudSales, userRole, historyCashierFilter, historySearchTerm]);

  // Cart Operations
  const addToCart = (drug) => {
    const retail = Number(drug.retailPrice ?? drug.retail_price ?? 0);
    const wholesale = Number(drug.wholesalePrice ?? drug.wholesale_price ?? 0);
    const activePrice = saleType === 'wholesale' ? wholesale : retail;

    const existingIndex = cart.findIndex((item) => item.id === drug.id);

    if (existingIndex > -1) {
      const updated = [...cart];
      updated[existingIndex].quantity += 1;
      setCart(updated);
    } else {
      setCart([...cart, { ...drug, activePrice, quantity: 1 }]);
    }
  };

  const handleSaleTypeChange = (type) => {
    setSaleType(type);
    if (cart.length > 0) {
      setCart(
        cart.map((item) => {
          const retail = Number(item.retailPrice ?? item.retail_price ?? 0);
          const wholesale = Number(item.wholesalePrice ?? item.wholesale_price ?? 0);
          return {
            ...item,
            activePrice: type === 'wholesale' ? wholesale : retail
          };
        })
      );
    }
  };

  const updateQuantity = (id, delta) => {
    setCart(
      cart
        .map((item) => {
          if (item.id === id) {
            const newQty = item.quantity + delta;
            return newQty > 0 ? { ...item, quantity: newQty } : null;
          }
          return item;
        })
        .filter(Boolean)
    );
  };

  const cartTotal = cart.reduce((sum, item) => sum + item.activePrice * item.quantity, 0);

  // Complete Sale Logic with Direct Cloud Sync + Local Fallback
  const handleCheckout = async () => {
    if (cart.length === 0) return;

    try {
      const saleId = `REC-${Date.now()}`;
      const saleData = {
        id: saleId,
        total: cartTotal,
        saleType,
        cashierId: session?.user?.id || 'offline_id',
        cashierEmail: session?.user?.email || 'offline_cashier',
        customerName: customerName.trim() || 'Walk-in Customer',
        customerPhone: customerPhone.trim() || 'N/A',
        createdAt: new Date().toISOString(),
        items: [...cart],
        synced: 0
      };

      // 1. Deduct stock locally in Dexie
      for (const item of cart) {
        if (item.id) {
          const existingDrug = await db.drugs.get(String(item.id));
          if (existingDrug) {
            const newStock = Math.max(0, (existingDrug.stock || 0) - item.quantity);
            await db.drugs.update(String(item.id), { stock: newStock });

            // Sync stock deduction to Supabase if online
            if (isOnline) {
              supabase
                .from('drugs')
                .update({ stock: newStock })
                .eq('id', String(item.id))
                .then();
            }
          }
        }
      }

      // 2. Save sale record locally in Dexie
      await db.sales.add(saleData);

      // 3. Direct Cloud Push if Online
      if (isOnline) {
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

        const { error } = await supabase.from('sales').insert([supabasePayload]);
        if (!error) {
          await db.sales.update(saleId, { synced: 1 });
          saleData.synced = 1;
          fetchCloudSales();
        } else {
          console.warn('Cloud insert pending, queued locally:', error.message);
        }
      }

      // 4. Launch printable receipt on screen
      setSaleSuccessData(saleData);
      setShowReceiptModal(true);

      // 5. Reset cart and inputs
      setCart([]);
      setCustomerName('');
      setCustomerPhone('');
    } catch (err) {
      console.error('Checkout error:', err);
      alert(`Checkout failed: ${err.message || 'Error processing database transaction'}`);
    }
  };

  // Manager CRUD Handlers (Updates Dexie + Supabase)
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
      name: drug.name,
      unitType: drug.unitType || drug.unit_type || 'Sachet',
      costPrice: drug.costPrice ?? drug.cost_price ?? '',
      retailPrice: drug.retailPrice ?? drug.retail_price ?? '',
      wholesalePrice: drug.wholesalePrice ?? drug.wholesale_price ?? '',
      stock: drug.stock ?? '',
      barcode: drug.barcode || ''
    });
    setIsModalOpen(true);
  };

  const handleDeleteDrug = async (id, e) => {
    e.stopPropagation();
    if (window.confirm('Are you sure you want to delete this drug from inventory?')) {
      await db.drugs.delete(String(id));
      if (isOnline) {
        await supabase.from('drugs').delete().eq('id', String(id));
      }
    }
  };

  const handleSaveDrug = async (e) => {
    e.preventDefault();
    const drugId = editingDrug ? String(editingDrug.id) : Date.now().toString();
    const drugPayload = {
      id: drugId,
      name: formData.name,
      unitType: formData.unitType,
      costPrice: Number(formData.costPrice),
      retailPrice: Number(formData.retailPrice),
      wholesalePrice: Number(formData.wholesalePrice),
      stock: Number(formData.stock),
      barcode: formData.barcode
    };

    if (editingDrug) {
      await db.drugs.update(drugId, drugPayload);
    } else {
      await db.drugs.add(drugPayload);
    }

    if (isOnline) {
      const cloudPayload = {
        id: drugId,
        name: formData.name,
        unit_type: formData.unitType,
        cost_price: Number(formData.costPrice),
        retail_price: Number(formData.retailPrice),
        wholesale_price: Number(formData.wholesalePrice),
        stock: Number(formData.stock),
        barcode: formData.barcode
      };
      await supabase.from('drugs').upsert([cloudPayload]);
    }

    setIsModalOpen(false);
  };

  // ------------------- LOGIN SCREEN -------------------
  if (!session) {
    return (
      <div className="login-container">
        <div className="login-card">
          <h2>AZU PHARMACY POS</h2>
          <p>Please log in to continue</p>
          {authError && <div className="auth-error">{authError}</div>}
          <form onSubmit={handleLogin}>
            <label>Email Address:</label>
            <input
              type="email"
              required
              placeholder="cashier@azupharmacy.com"
              value={loginEmail}
              onChange={(e) => setLoginEmail(e.target.value)}
            />
            
            <label>Password:</label>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <input
                type={showPassword ? 'text' : 'password'}
                required
                placeholder="••••••••"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                style={{ width: '100%', paddingRight: '2.5rem' }}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  position: 'absolute',
                  right: '10px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                  fontWeight: 'bold',
                  color: '#666'
                }}
              >
                {showPassword ? 'HIDE' : 'SHOW'}
              </button>
            </div>

            <button type="submit" className="login-btn">Sign In</button>
          </form>
        </div>
      </div>
    );
  }

  // ------------------- MAIN POS APP SCREEN -------------------
  return (
    <div className="app-container">
      <header className="header no-print">
        <div>
          <h1>AZU PHARMACY POS</h1>
          <span className={`status-badge ${isOnline ? 'online' : 'offline'}`}>
            {isOnline ? '● Online' : '○ Offline'}
          </span>
        </div>

        {/* Navigation Tabs */}
        <nav className="nav-tabs">
          <button
            className={activeTab === 'pos' ? 'active-tab' : ''}
            onClick={() => setActiveTab('pos')}
          >
            🛒 POS Terminal
          </button>
          <button
            className={activeTab === 'history' ? 'active-tab' : ''}
            onClick={() => setActiveTab('history')}
          >
            📋 Sales History
          </button>
        </nav>

        {/* User Account Info */}
        <div className="user-profile-header">
          <div>
            <div className="user-email">{session.user.email}</div>
            <div className="user-role-badge">{userRole.toUpperCase()} ACCOUNT</div>
          </div>
          <button className="logout-btn" onClick={handleLogout}>Sign Out</button>
        </div>
      </header>

      {/* POS TERMINAL TAB */}
      {activeTab === 'pos' && (
        <>
          <div className="price-mode-toggle no-print">
            <button
              className={saleType === 'retail' ? 'active' : ''}
              onClick={() => handleSaleTypeChange('retail')}
            >
              🛒 Retail Price
            </button>
            <button
              className={saleType === 'wholesale' ? 'active' : ''}
              onClick={() => handleSaleTypeChange('wholesale')}
            >
              📦 Wholesale Price
            </button>
          </div>

          <div className="pos-screen no-print">
            <div className="search-row">
              <input
                type="text"
                className="search-input"
                placeholder="Search drug name or barcode..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                autoFocus
              />
              {userRole === 'manager' && (
                <button className="add-drug-btn" onClick={handleOpenAddModal}>
                  + Add Drug
                </button>
              )}
            </div>

            <div className="drug-list">
              {drugs && drugs.length > 0 ? (
                drugs.map((drug) => {
                  const cost = Number(drug.costPrice ?? drug.cost_price ?? 0);
                  const retail = Number(drug.retailPrice ?? drug.retail_price ?? 0);
                  const wholesale = Number(drug.wholesalePrice ?? drug.wholesale_price ?? 0);
                  const unit = drug.unitType || drug.unit_type || 'Sachet';

                  return (
                    <div key={drug.id} className="drug-card" onClick={() => addToCart(drug)}>
                      <div className="drug-info">
                        <div className="drug-name">{drug.name}</div>
                        <div className="tags-row">
                          <span className="unit-tag">{unit}</span>
                          <span className={`stock-tag ${drug.stock < 10 ? 'low-stock' : ''}`}>
                            Stock: {drug.stock}
                          </span>
                        </div>
                      </div>

                      <div className="price-stack">
                        {userRole === 'manager' && (
                          <div className="price-item cost-price">
                            <small>Cost:</small> ₦{cost.toLocaleString()}
                          </div>
                        )}
                        <div className={`price-item ${saleType === 'retail' ? 'highlight' : ''}`}>
                          <small>Retail:</small> ₦{retail.toLocaleString()}
                        </div>
                        <div className={`price-item ${saleType === 'wholesale' ? 'highlight' : ''}`}>
                          <small>Wholesale:</small> ₦{wholesale.toLocaleString()}
                        </div>

                        {userRole === 'manager' && (
                          <div className="manager-actions">
                            <button onClick={(e) => handleOpenEditModal(drug, e)}>✏️ Edit</button>
                            <button onClick={(e) => handleDeleteDrug(drug.id, e)} className="del-btn">🗑️</button>
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

            {/* Cart & Customer Drawer */}
            {cart.length > 0 && (
              <div className="cart-drawer">
                <div className="cart-header">
                  <h3>Current Cart ({saleType.toUpperCase()})</h3>
                </div>

                {/* Customer Details Form */}
                <div className="customer-info-section">
                  <h4>Customer Information</h4>
                  <div className="customer-input-row">
                    <input
                      type="text"
                      placeholder="Customer Name (Optional)"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                    />
                    <input
                      type="tel"
                      placeholder="Phone Number (Optional)"
                      value={customerPhone}
                      onChange={(e) => setCustomerPhone(e.target.value)}
                    />
                  </div>
                </div>

                <div className="cart-items-list">
                  {cart.map((item) => (
                    <div key={item.id} className="cart-item">
                      <div>
                        <strong>{item.name}</strong>
                        <div className="unit-price">
                          ₦{item.activePrice.toLocaleString()} per {item.unitType || item.unit_type}
                        </div>
                      </div>
                      <div className="qty-controls">
                        <button onClick={() => updateQuantity(item.id, -1)}>-</button>
                        <span>{item.quantity}</span>
                        <button onClick={() => updateQuantity(item.id, 1)}>+</button>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="cart-summary">
                  <div>Total: <strong>₦{cartTotal.toLocaleString()}</strong></div>
                  <button className="checkout-btn" onClick={handleCheckout}>Complete Sale</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* SALES HISTORY TAB */}
      {activeTab === 'history' && (
        <div className="history-screen no-print">
          <div className="history-header-row">
            <h2>
              {userRole === 'manager' ? 'All Customer Sales History (1 Year)' : 'My Sales History (1 Year)'}
            </h2>
            <div className="history-filter-controls">
              <input
                type="text"
                placeholder="Search Customer Name or Phone..."
                value={historySearchTerm}
                onChange={(e) => setHistorySearchTerm(e.target.value)}
                className="history-search-input"
              />

              {userRole === 'manager' && (
                <select
                  value={historyCashierFilter}
                  onChange={(e) => setHistoryCashierFilter(e.target.value)}
                  className="history-cashier-select"
                >
                  <option value="all">All Cashiers</option>
                  {Array.from(new Set(salesHistory?.map((s) => s.cashierEmail))).map((email) => (
                    <option key={email} value={email}>{email}</option>
                  ))}
                </select>
              )}
            </div>
          </div>

          <div className="sales-list">
            {salesHistory && salesHistory.length > 0 ? (
              salesHistory.map((sale) => (
                <div key={sale.id} className="sale-history-card">
                  <div className="sale-card-header">
                    <div>
                      <strong>Receipt #{sale.id}</strong>
                      <span className="sale-date"> - {new Date(sale.createdAt).toLocaleString()}</span>
                    </div>
                    <span className="sale-type-pill">{sale.saleType.toUpperCase()}</span>
                  </div>

                  <div className="sale-customer-details">
                    <span>👤 <strong>Customer:</strong> {sale.customerName || 'Walk-in Customer'}</span>
                    <span>📞 <strong>Phone:</strong> {sale.customerPhone || 'N/A'}</span>
                    <span>💳 <strong>Cashier:</strong> {sale.cashierEmail}</span>
                  </div>

                  <div className="sale-items-table">
                    {sale.items && sale.items.map((item, idx) => (
                      <div key={idx} className="sale-item-row">
                        <span>{item.name} ({item.unitType || item.unit_type}) x{item.quantity}</span>
                        <span>₦{(item.activePrice * item.quantity).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>

                  <div className="sale-card-footer">
                    <div>Total Amount: <strong>₦{sale.total.toLocaleString()}</strong></div>
                    <button
                      className="receipt-btn"
                      onClick={() => {
                        setSaleSuccessData(sale);
                        setShowReceiptModal(true);
                      }}
                    >
                      🖨️ View Receipt
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-state">No sales history found.</div>
            )}
          </div>
        </div>
      )}

      {/* PRINTABLE RECEIPT & SALE COMPLETION MODAL */}
      {showReceiptModal && saleSuccessData && (
        <div className="receipt-container">
          <div className="receipt-card">
            <div className="receipt-header">
              <h2>AZU PHARMACY</h2>
              <p>Sales Receipt ({saleSuccessData.saleType.toUpperCase()})</p>
              <p><strong>Receipt #:</strong> {saleSuccessData.id}</p>
              <p><strong>Cashier:</strong> {saleSuccessData.cashierEmail}</p>
              <p><strong>Customer:</strong> {saleSuccessData.customerName} ({saleSuccessData.customerPhone})</p>
              <p><strong>Date:</strong> {new Date(saleSuccessData.createdAt).toLocaleString()}</p>
            </div>
            <hr />
            <div className="receipt-items">
              {saleSuccessData.items.map((item, index) => (
                <div key={index} className="receipt-item-row">
                  <span>{item.name} ({item.unitType || item.unit_type}) x{item.quantity}</span>
                  <span>₦{(item.activePrice * item.quantity).toLocaleString()}</span>
                </div>
              ))}
            </div>
            <hr />
            <div className="receipt-total">
              <strong>TOTAL PAID:</strong>
              <strong>₦{saleSuccessData.total.toLocaleString()}</strong>
            </div>
            <p className="receipt-footer">Thank you for your patronage!</p>

            <div className="receipt-actions no-print">
              <button className="print-btn" onClick={() => window.print()}>
                🖨️ Print Receipt
              </button>
              <button
                className="close-btn"
                onClick={() => {
                  setShowReceiptModal(false);
                  setSaleSuccessData(null);
                }}
              >
                Close & Start New Sale
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manager Add / Edit Drug Modal */}
      {isModalOpen && userRole === 'manager' && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h3>{editingDrug ? 'Edit Drug Details' : 'Add New Drug'}</h3>
            <form onSubmit={handleSaveDrug} className="crud-form">
              <label>Drug Name:</label>
              <input
                type="text"
                required
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />

              <label>Unit Type:</label>
              <select
                value={formData.unitType}
                onChange={(e) => setFormData({ ...formData, unitType: e.target.value })}
              >
                <option value="Sachet">Sachet</option>
                <option value="Pack">Pack</option>
                <option value="Bottle">Bottle</option>
              </select>

              <div className="form-row">
                <div>
                  <label>Cost Price (₦):</label>
                  <input
                    type="number"
                    required
                    value={formData.costPrice}
                    onChange={(e) => setFormData({ ...formData, costPrice: e.target.value })}
                  />
                </div>
                <div>
                  <label>Retail Price (₦):</label>
                  <input
                    type="number"
                    required
                    value={formData.retailPrice}
                    onChange={(e) => setFormData({ ...formData, retailPrice: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-row">
                <div>
                  <label>Wholesale Price (₦):</label>
                  <input
                    type="number"
                    required
                    value={formData.wholesalePrice}
                    onChange={(e) => setFormData({ ...formData, wholesalePrice: e.target.value })}
                  />
                </div>
                <div>
                  <label>Stock Qty:</label>
                  <input
                    type="number"
                    required
                    value={formData.stock}
                    onChange={(e) => setFormData({ ...formData, stock: e.target.value })}
                  />
                </div>
              </div>

              <label>Barcode (Optional):</label>
              <input
                type="text"
                value={formData.barcode}
                onChange={(e) => setFormData({ ...formData, barcode: e.target.value })}
              />

              <div className="modal-actions">
                <button type="submit" className="save-btn">Save Changes</button>
                <button type="button" className="cancel-btn" onClick={() => setIsModalOpen(false)}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}