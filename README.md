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
| **Styling** | **CSS3** | Responsive layouts, CSS Grid, Flexbox, modal overlays, and print style sheets (`@media print`) |
| **Database & Auth** *(Backend Integration)* | **Supabase / PostgreSQL** | Relational data persistence, Row-Level Security (RLS), and authentication |

---

## 🏗️ Software Architecture & Core Components

The core user interface is built around a centralized application container (`App.jsx`) driven by a tabbed layout system (`POS Terminal` vs. `Sales History`).
