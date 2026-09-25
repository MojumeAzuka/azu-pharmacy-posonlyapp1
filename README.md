# 💊 Azu Pharmacy POS & Inventory Management System

A web-based Point of Sale (POS), Inventory Control, and Sales Auditing System built specifically for retail pharmacy operations. The application enables cashiers to execute real-time sales transactions with dynamic pricing and automatic stock deduction while granting pharmacy managers administrative controls for inventory updates, price overrides, real-time analytics, and operational audit history.

---

## 📌 Project Overview & Purpose

In retail pharmacy environments, speed, accuracy, and stock auditability are critical operational bottlenecks. Legacy inventory tools often suffer from slow search interfaces, cumbersome cart management, and lack of real-time visibility into profit margins across tiered pricing models.

This software solves these core problems by offering:
1. **Tiered Pricing Support**: Seamless switching between **Retail** and **Wholesale** pricing models during live sales.
2. **Role-Based Access Control (RBAC)**: Enforces clear separation of concerns between operational **Cashiers** and administrative **Managers**.
3. **Automated Inventory Tracking**: Real-time stock decrement upon checkout with visual cues for low-stock warnings.
4. **Sales & Customer Auditing**: Integrated historical sales log supporting 1-year transactional tracking, customer detail capture, and printable receipts.

---

## 🛠️ Technology Stack

| Layer | Technology / Tool | Purpose |
| :--- | :--- | :--- |
| **Frontend Framework** | **React.js (v18+)** | Declarative component-based UI rendering and reactive state management |
| **State & Lifecycle** | **React Hooks** (`useState`, `useEffect`, `useRef`) | Local state control, side-effect synchronization, and DOM refs |
| **Language** | **JavaScript (ES6+)** | Core application logic, array mutations, and asynchronous operations |
| **Local Persistence** | **Dexie.js (IndexedDB)** | On-device offline-first storage for drugs and sales, synced with the cloud |
| **Styling** | **CSS3** | Responsive layouts, CSS Grid, Flexbox, sticky header, modal overlays, and print style sheets (`@media print`) |
| **Database & Auth** *(Backend Integration)* | **Supabase / PostgreSQL** | Relational data persistence, Row-Level Security (RLS), and authentication |

---

## 🏗️ Software Architecture & Core Components

The core user interface is built around a centralized application container (`App.jsx`) driven by a sticky header and a tabbed layout system (`POS Terminal` vs. `Sales History`).

```
App.jsx (Root Application Component)
├── Sticky Navigation & Header Bar
│   ├── Navigation Tabs (displayed as "🛒 POS" / "📋 History")
│   ├── Sale Mode Toggle (Retail / Wholesale)
│   ├── Add Drug Button (manager only, grouped with the nav/mode buttons)
│   └── User Role Controller (Manager / Cashier View Switcher)
├── POS Terminal Section (`activeTab === 'pos'`)
│   ├── Drug Catalog Section (`.pos-catalog-section`)
│   │   └── Drug Card Grid (`.drug-list` -> `.drug-card`)
│   └── Cart Sidebar Section (`.cart-sidebar-wrapper`)
│       ├── Customer Detail Inputs (Name & Phone)
│       ├── Cart Item List (`.cart-items-list` with Qty Controls, internally scrollable)
│       └── Summary & Checkout CTA (`.cart-summary`)
├── Sales History View (`activeTab === 'history'`)
│   ├── Filter & Search Controls (Search Input & Cashier Select)
│   └── Historical Sales Cards (`.sale-history-card`)
├── Modals & Overlays
│   ├── Printable Receipt Modal (`.receipt-container`)
│   └── Add/Edit Inventory Modal (`.modal-card`)
```

---

## ✨ Key Features & Implementation Details

### 1. Dynamic Drug Catalog & Dual-Price Engine
- **Implementation**: Reads from a reactive `drugs` collection. Normalizes data keys to seamlessly handle both camelCase (`costPrice`, `retailPrice`, `wholesalePrice`, `unitType`) and snake_case (`cost_price`, `retail_price`, `wholesale_price`, `unit_type`) payloads from backend ORM/SQL endpoints.
- **Dynamic Pricing**: Visual highlights reflect the active `saleType` (Retail vs. Wholesale) across catalog cards.
- **Manager Security**: Cost prices and inline Edit/Delete action buttons are strictly rendered only when `userRole === 'manager'`.

### 2. Interactive Cart & Stock Handling
- **Quantities**: Allows real-time incrementing/decrementing of items in the cart.
- **Non-Negative Stock**: On checkout, stock is decremented and clamped so it never drops below zero (`Math.max(0, stock - quantity)`).
- **Auto-Scroll Behavior**: Utilizes React `useRef` (`cartListRef`) to smoothly scroll the cart's own item list to newly added items, without scrolling the page.
- **Customer Association**: Allows linking walk-in or returning customer information (Name & Phone) directly to the transaction payload.

> Note: The cart does not currently block a cashier from adding more units than are in stock — see Roadmap.

### 3. Historical Sales Audit Log
- **Filtering**: Real-time client-side searching by customer name/phone and cashier-based filtering for store managers.
- **Data Preservation**: Stores full snapshots of item states at the time of purchase (`activePrice`, `unitType`, `quantity`) to maintain financial integrity even if drug prices change later in the inventory database.
- **Retention**: Local records older than one year are automatically pruned (`pruneSalesOlderThanOneYear`); cloud queries are likewise scoped to the trailing 12 months.

### 4. Native Receipt Generation & Thermal Printing
- **CSS `@media print` Optimizations**: Uses conditional CSS wrappers (`.no-print` vs `.receipt-container`) to isolate the printable receipt layout during browser `window.print()` triggers, stripping away surrounding web UI elements.

### 5. Inventory Management (CRUD)
- **Modal-Driven Forms**: Managers can create new drug records or mutate existing ones (Name, Unit Type, Cost, Retail, Wholesale, Stock, Barcode) via controlled inputs.
- **Barcode-Aware Search**: The drug search bar already matches against both name and barcode text; a hardware barcode-scanner listener (treating scans as fast keyboard input) is still on the roadmap — see below.

### 6. Responsive, Sticky Layout
- **Mobile**: The cart renders as a fixed bottom drawer with its own internally scrolling item list, so a long cart never pushes the checkout button off-screen or covers the whole catalog.
- **Desktop/Tablet (≥768px)**: The layout switches to a two-column split view — catalog on the left, a sticky cart on the right — with the header, nav tabs, sale-mode toggle, Add Drug button, and search bar all pinned to the top of the viewport.

---

## 🧩 Comprehensive Purpose Breakdown of Software Parts

### A. Navigation & Bar Header
- **Purpose**: Acts as the central operational cockpit. Controls global application state: which tab is visible, whether sales are executed at retail or wholesale rates, and toggling manager privileges. It stays pinned to the top of the screen so these controls are always reachable, however far down the catalog or cart the user has scrolled.

### B. Drug Catalog Grid (`.pos-catalog-section`)
- **Purpose**: Displays the real-time stock list. Acts as the primary input area for cashiers.
- **Mechanism**: Tapping a drug triggers `addToCart()`, pushing the item to the cart state while automatically applying the currently active pricing tier.

### C. Cart Drawer (`.cart-sidebar-wrapper`)
- **Purpose**: Holds pending sales transactions. Computes sub-totals and final payable amounts on the fly.
- **Mechanism**: Handles customer contact capture and updates quantity metrics before committing the final checkout.

### D. Sales History Screen (`.history-screen`)
- **Purpose**: Provides administrative oversight, transactional transparency, and auditability.
- **Mechanism**: Renders transaction cards containing timestamped receipts, cashier identifiers, customer contact records, and breakdown of purchased items.

### E. Printable Receipt Component (`.receipt-container`)
- **Purpose**: Provides paper receipts for customers or store physical archives.
- **Mechanism**: Mounts when a sale completes or when a historical receipt button is pressed. Interfaces directly with `window.print()`.

### F. Add/Edit Inventory Modal (`.modal-overlay`)
- **Purpose**: Ensures database accuracy by allowing managers to add stock shipments, update purchase costs, adjust pricing margins, or modify drug metadata.

---

## 🚀 Future Roadmap
- [ ] Cart-level stock validation (block adding more units to the cart than are currently in stock).
- [ ] Hardware barcode scanner integration (listen for fast keystroke-then-Enter input as a scan event).
- [ ] Direct Supabase database sync triggers for low-stock webhooks.
- [ ] Daily financial summary export (CSV/PDF) for manager shift closes.
- [ ] Administrator role, above Manager: deleted-record recovery, permanent deletion, bulk sales-history deletion by date range, and an audit/notification log of manager and admin changes.

---

# 🗣️ How to Explain This Project to Non-Technical People

When explaining this application to friends, family, or business owners, avoid jargon like *"React state"*, *"PostgreSQL schema"*, or *"camelCase vs snake_case normalization"*. Use real-world analogies based on running a business.

Here are three simple ways to explain it depending on who you are talking to:

---

### 1. The "Elevator Pitch" (30 Seconds)

> *"I built a custom digital cash register and stock management system designed specifically for pharmacies. It lets cashiers quickly scan or tap items to make a sale, prints receipts, and automatically updates the stock numbers in real-time so the pharmacy never accidentally runs out of medicine. It also gives the store manager special access to set wholesale vs. retail prices, check daily profits, and manage inventory."*

---

### 2. A Simple Breakdown of How It Works (The "Tour")

* **The Cash Register (POS Terminal)**:
> *"Think of this as the main screen the cashier looks at. On the left is a digital shelf showing every drug available, how much stock is left, and its prices. On the right is the shopping cart where items pop up as you tap them. The buttons for switching screens, switching pricing, and searching all stay fixed at the top, so you never have to scroll back up to use them."*

* **Retail vs. Wholesale Switch**:
> *"Pharmacies sell drugs in two ways: to everyday walk-in customers (Retail) or in bulk to hospitals and smaller shops (Wholesale). With one click, the cashier can toggle between Retail and Wholesale mode, and all the prices instantly adjust across the whole screen automatically."*

* **The Manager's Master Key**:
> *"Not everyone gets to see everything. Cashiers only see what they need to make sales. But when a manager logs in, extra features appear—like seeing what the pharmacy actually paid to buy the drugs (Cost Price), editing stock numbers, or adding new medicines to the system."*

* **The History & Audit Log**:
> *"Every single completed sale gets logged with a date, timestamp, cashier name, customer phone number, and a copy of the receipt. If a customer comes back asking for a refund or a question about a past purchase, the manager can search their phone number and find the exact receipt in seconds."*

---

### 3. Why This Matters (The Real Business Value)

* **Prevents Theft & Errors**: Staff can't manually guess or change prices at the counter because prices are set by management in the system.
* **Saves Time**: Cashiers don't have to calculate wholesale discounts manually using a paper calculator; the system automatically does the math.
* **No Stock Outages**: A red highlight warns staff when a drug's stock drops below 10 units so the store knows when to reorder from suppliers before running out.
