import Dexie from 'dexie';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://bolybwvzpbhetyedzlmo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJvbHlid3Z6cGJoZXR5ZWR6bG1vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAxNjAzNDAsImV4cCI6MjEwNTczNjM0MH0.wwgFXOb7LOxxnlbSf-2CZXRZZ-V-1bIaF_Su87AhFGo';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export const db = new Dexie('AzuPharmacyPOS');

// Schema Version 4: Indexed fields for role filtering, customer tracking, and 1-year retention
db.version(4).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, createdAt, synced'
});

// Schema Version 5: adds the audit log table used by the administrator
// role. `drugs` records also now carry `deletedAt` / `deletedBy` fields
// for soft-delete + recovery, but those are plain (non-indexed) fields,
// so the `drugs` and `sales` index lists below don't need to change —
// only the new `auditLog` table needed adding.
db.version(5).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, createdAt, synced',
  auditLog: 'id, createdAt, synced'
});

// Schema Version 6: adds `synced` to drugs. Sales and the audit log have
// always had a retry mechanism — a failed cloud write leaves `synced: 0`
// locally, and the next reconnect automatically pushes it up. Drugs never
// had this. A drug added while the cloud upsert fails (weak mobile
// signal, a dropped connection, a PWA/service-worker quirk — "Load
// failed" is WebKit's generic network-failure message, not a Supabase
// error) was simply stuck unsynced forever, with no automatic recovery.
// This closes that gap using the exact same pattern sales already use.
db.version(6).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode, synced',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, createdAt, synced',
  auditLog: 'id, createdAt, synced'
});

// Schema Version 7:
//  - `sales` gains `reversalPending` (indexed) — a partial reversal is
//    now written locally first and retried against the cloud, the same
//    write-then-sync pattern everything else already uses, instead of
//    silently failing if the cloud update was rejected (e.g. by RLS)
//    or the device was offline.
//  - Two new tables for the attendant/cashier ticket workflow:
//    `tickets` (a cart an attendant built for a customer, pending
//    payment approval by a cashier) and `bankOptions` (the admin-
//    managed list of banks a cashier can record a transfer against).
db.version(7).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode, synced',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, createdAt, synced, reversalPending',
  auditLog: 'id, createdAt, synced',
  tickets: 'id, status, attendantId, attendantEmail, cashierId, cashierEmail, createdAt, synced',
  bankOptions: 'id, name, active, synced'
});

// Schema Version 8: `reversalRequests` — a cashier reversing an item (or
// part of one) no longer happens instantly. It's recorded as a request
// here and only actually applied (stock restored, sale total reduced)
// once a manager or administrator approves it. A manager/administrator
// reversing something themselves still happens immediately — this table
// only exists for the cashier-initiated, needs-approval path.
db.version(8).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode, synced',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, createdAt, synced, reversalPending',
  auditLog: 'id, createdAt, synced',
  tickets: 'id, status, attendantId, attendantEmail, cashierId, cashierEmail, createdAt, synced',
  bankOptions: 'id, name, active, synced',
  reversalRequests: 'id, saleId, status, requestedByEmail, createdAt, synced'
});

// Schema Version 9: the supplier restock workflow — `suppliers` (a
// simple reusable address book, same shape of pattern as bankOptions)
// and `stockEntries` (a batch of drugs received from one supplier on
// one occasion, each either an existing drug's stock going up or a
// brand-new drug being created). A cashier's stock entry sits as
// PENDING until a manager approves it; a manager's own entry applies
// immediately (APPLIED) — the same cashier-needs-approval shape as
// reversalRequests above, reused for a different kind of change.
db.version(9).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode, synced',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, createdAt, synced, reversalPending',
  auditLog: 'id, createdAt, synced',
  tickets: 'id, status, attendantId, attendantEmail, cashierId, cashierEmail, createdAt, synced',
  bankOptions: 'id, name, active, synced',
  reversalRequests: 'id, saleId, status, requestedByEmail, createdAt, synced',
  suppliers: 'id, name, synced',
  stockEntries: 'id, status, supplierId, enteredByEmail, createdAt, synced'
});

// Schema Version 10:
//  - `stockEntryEdits` — editing a stock entry within a week of it being
//    entered (even one already APPLIED) follows the same cashier-needs-
//    approval shape as everything else here. A manager's edit applies
//    immediately; a cashier's edit to their own entry sits here as
//    PENDING until a manager approves or rejects it.
//  - `restockDrafts` — the in-progress "building a restock entry"
//    screen (chosen/new supplier, drugs added so far) persists across
//    tab switches and reloads so a cashier/manager can step away to
//    attend a customer and come back later, WITHOUT it following them
//    onto a different account on the same device. One row per account
//    (keyed by email), local-only — this is scratch/WIP state, never
//    pushed to the cloud, so it doesn't follow an account across
//    devices, only across sessions on the same device.
db.version(10).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode, synced',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, createdAt, synced, reversalPending',
  auditLog: 'id, createdAt, synced',
  tickets: 'id, status, attendantId, attendantEmail, cashierId, cashierEmail, createdAt, synced',
  bankOptions: 'id, name, active, synced',
  reversalRequests: 'id, saleId, status, requestedByEmail, createdAt, synced',
  suppliers: 'id, name, synced',
  stockEntries: 'id, status, supplierId, enteredByEmail, createdAt, synced',
  stockEntryEdits: 'id, stockEntryId, status, requestedByEmail, createdAt, synced',
  restockDrafts: 'id'
});

// Schema Version 11:
//  - `supplierChangeRequests` — a cashier editing or deleting a supplier
//    follows the same cashier-needs-approval shape as everything else
//    here; a manager's own edit/delete applies immediately.
//  - `purchaseLists` — the saved/editable/printable output of the
//    automated "what needs buying" scan (finished or below-minimum
//    drugs, grouped by the supplier they're usually bought from).
db.version(11).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode, synced',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, createdAt, synced, reversalPending',
  auditLog: 'id, createdAt, synced',
  tickets: 'id, status, attendantId, attendantEmail, cashierId, cashierEmail, createdAt, synced',
  bankOptions: 'id, name, active, synced',
  reversalRequests: 'id, saleId, status, requestedByEmail, createdAt, synced',
  suppliers: 'id, name, synced',
  stockEntries: 'id, status, supplierId, enteredByEmail, createdAt, synced',
  stockEntryEdits: 'id, stockEntryId, status, requestedByEmail, createdAt, synced',
  restockDrafts: 'id',
  supplierChangeRequests: 'id, status, supplierId, requestedByEmail, createdAt, synced',
  purchaseLists: 'id, createdByEmail, createdAt, synced'
});

// Schema Version 12: `drugChangeRequests` — drugs can now be created,
// edited and deleted from the Drugs & Suppliers hub by a cashier, not
// just a manager. Creating one is unrestricted either way (same as
// suppliers), but editing or deleting a drug as a cashier follows the
// exact same cashier-needs-approval shape used everywhere else: a
// manager's own edit/delete applies immediately, a cashier's sits here
// as PENDING until a manager approves or rejects it.
db.version(12).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode, synced',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, createdAt, synced, reversalPending',
  auditLog: 'id, createdAt, synced',
  tickets: 'id, status, attendantId, attendantEmail, cashierId, cashierEmail, createdAt, synced',
  bankOptions: 'id, name, active, synced',
  reversalRequests: 'id, saleId, status, requestedByEmail, createdAt, synced',
  suppliers: 'id, name, synced',
  stockEntries: 'id, status, supplierId, enteredByEmail, createdAt, synced',
  stockEntryEdits: 'id, stockEntryId, status, requestedByEmail, createdAt, synced',
  restockDrafts: 'id',
  supplierChangeRequests: 'id, status, supplierId, requestedByEmail, createdAt, synced',
  purchaseLists: 'id, createdByEmail, createdAt, synced',
  drugChangeRequests: 'id, status, drugId, requestedByEmail, createdAt, synced'
});

// Schema Version 13: `purchasePlans` — replaces the old "generate a
// snapshot, save it, reopen it" purchase list with one persistent row
// per drug (keyed by drugId itself, not a generated id). A drug's
// desired purchase quantity, chosen supplier and "not to buy right
// now" flag are stored continuously and edited in place — searchable,
// always reflecting the current plan, with no separate save step.
// `purchaseLists` (the old snapshot table) is left in place for
// backward compatibility with anything already saved there, but the
// UI no longer writes new ones.
db.version(13).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode, synced',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, createdAt, synced, reversalPending',
  auditLog: 'id, createdAt, synced',
  tickets: 'id, status, attendantId, attendantEmail, cashierId, cashierEmail, createdAt, synced',
  bankOptions: 'id, name, active, synced',
  reversalRequests: 'id, saleId, status, requestedByEmail, createdAt, synced',
  suppliers: 'id, name, synced',
  stockEntries: 'id, status, supplierId, enteredByEmail, createdAt, synced',
  stockEntryEdits: 'id, stockEntryId, status, requestedByEmail, createdAt, synced',
  restockDrafts: 'id',
  supplierChangeRequests: 'id, status, supplierId, requestedByEmail, createdAt, synced',
  purchaseLists: 'id, createdByEmail, createdAt, synced',
  drugChangeRequests: 'id, status, drugId, requestedByEmail, createdAt, synced',
  purchasePlans: 'drugId, excluded, synced'
});

// Schema Version 14: wholesale customers — a real record (not just
// free-text name/phone on a ticket), CRUD'd the same cashier-approval
// way as drugs and suppliers, carrying a running `balance` (positive =
// they owe the pharmacy, negative = the pharmacy owes them credit).
// `customerId` is now indexed on both tickets and sales so a
// customer's purchase/payment history can be looked up directly.
db.version(14).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode, synced',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, customerId, createdAt, synced, reversalPending',
  auditLog: 'id, createdAt, synced',
  tickets: 'id, status, attendantId, attendantEmail, cashierId, cashierEmail, customerId, createdAt, synced',
  bankOptions: 'id, name, active, synced',
  reversalRequests: 'id, saleId, status, requestedByEmail, createdAt, synced',
  suppliers: 'id, name, synced',
  stockEntries: 'id, status, supplierId, enteredByEmail, createdAt, synced',
  stockEntryEdits: 'id, stockEntryId, status, requestedByEmail, createdAt, synced',
  restockDrafts: 'id',
  supplierChangeRequests: 'id, status, supplierId, requestedByEmail, createdAt, synced',
  purchaseLists: 'id, createdByEmail, createdAt, synced',
  drugChangeRequests: 'id, status, drugId, requestedByEmail, createdAt, synced',
  purchasePlans: 'drugId, excluded, synced',
  customers: 'id, name, synced',
  customerChangeRequests: 'id, status, customerId, requestedByEmail, createdAt, synced'
});

// Schema Version 15: `settings` — a small generic key/value store for
// admin-editable app-wide settings, starting with the pricing
// recommendation percentages (see PRICE RECOMMENDATION below). One row
// per setting, keyed by a short string id ('pricing' for now), so more
// settings can be added later without another schema bump.
db.version(15).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode, synced',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, customerId, createdAt, synced, reversalPending',
  auditLog: 'id, createdAt, synced',
  tickets: 'id, status, attendantId, attendantEmail, cashierId, cashierEmail, customerId, createdAt, synced',
  bankOptions: 'id, name, active, synced',
  reversalRequests: 'id, saleId, status, requestedByEmail, createdAt, synced',
  suppliers: 'id, name, synced',
  stockEntries: 'id, status, supplierId, enteredByEmail, createdAt, synced',
  stockEntryEdits: 'id, stockEntryId, status, requestedByEmail, createdAt, synced',
  restockDrafts: 'id',
  supplierChangeRequests: 'id, status, supplierId, requestedByEmail, createdAt, synced',
  purchaseLists: 'id, createdByEmail, createdAt, synced',
  drugChangeRequests: 'id, status, drugId, requestedByEmail, createdAt, synced',
  purchasePlans: 'drugId, excluded, synced',
  customers: 'id, name, synced',
  customerChangeRequests: 'id, status, customerId, requestedByEmail, createdAt, synced',
  settings: 'key, synced'
});

// v16 — cartDrafts: a customer cart a salesperson has set aside to
// continue later (not yet sent to the cashier). Purely local/offline —
// never pushed to Supabase, same as the in-memory drafts this replaces
// persistence for — so a device restart, accidental tab close, or the
// end of a shift doesn't lose a half-built cart. Scoped per attendant
// (attendantEmail) so one salesperson doesn't see another's saved carts.
db.version(16).stores({
  drugs: 'id, name, unitType, costPrice, retailPrice, wholesalePrice, stock, barcode, synced',
  sales: 'id, total, saleType, cashierId, cashierEmail, customerName, customerPhone, customerId, createdAt, synced, reversalPending',
  auditLog: 'id, createdAt, synced',
  tickets: 'id, status, attendantId, attendantEmail, cashierId, cashierEmail, customerId, createdAt, synced',
  bankOptions: 'id, name, active, synced',
  reversalRequests: 'id, saleId, status, requestedByEmail, createdAt, synced',
  suppliers: 'id, name, synced',
  stockEntries: 'id, status, supplierId, enteredByEmail, createdAt, synced',
  stockEntryEdits: 'id, stockEntryId, status, requestedByEmail, createdAt, synced',
  restockDrafts: 'id',
  supplierChangeRequests: 'id, status, supplierId, requestedByEmail, createdAt, synced',
  purchaseLists: 'id, createdByEmail, createdAt, synced',
  drugChangeRequests: 'id, status, drugId, requestedByEmail, createdAt, synced',
  purchasePlans: 'drugId, excluded, synced',
  customers: 'id, name, synced',
  customerChangeRequests: 'id, status, customerId, requestedByEmail, createdAt, synced',
  settings: 'key, synced',
  cartDrafts: 'id, attendantEmail, savedAt'
});

// ============================================================
// ROLE HIERARCHY
// administrator > manager > cashier > salesperson. A higher role can
// do everything a lower role can, plus its own extra features. Cashier
// sits between salesperson and manager: a cashier does everything a
// salesperson (attendant) can, PLUS approve/complete pending tickets —
// but doesn't automatically get manager-level inventory/admin rights.
// Managers and administrators, being higher ranked, can also act as a
// cashier (approve tickets) when needed.
// ============================================================
export const ROLE_RANK = {
  salesperson: 0,
  cashier: 1,
  manager: 2,
  administrator: 3
};

export function hasRole(role, minimumRole) {
  return (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[minimumRole] ?? 0);
}

function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

export async function ensureSeedData() {
  const count = await db.drugs.count();
  if (count === 0) {
    await db.drugs.bulkPut([
      { id: '1', name: 'Paracetamol 500mg', unitType: 'Sachet', costPrice: 350, retailPrice: 500, wholesalePrice: 420, stock: 200, barcode: '1001' },
      { id: '2', name: 'Amoxicillin 500mg', unitType: 'Pack', costPrice: 1800, retailPrice: 2500, wholesalePrice: 2100, stock: 50, barcode: '1002' },
      { id: '3', name: 'Arthemeter/Lume 80/480', unitType: 'Pack', costPrice: 2200, retailPrice: 3200, wholesalePrice: 2750, stock: 40, barcode: '1003' },
      { id: '4', name: 'Emzolyn Cough Syrup 100ml', unitType: 'Bottle', costPrice: 1000, retailPrice: 1500, wholesalePrice: 1250, stock: 85, barcode: '1004' },
      { id: '5', name: 'Vitamin C 500mg', unitType: 'Sachet', costPrice: 500, retailPrice: 800, wholesalePrice: 650, stock: 300, barcode: '1005' },
      { id: '6', name: 'Ibuprofen 400mg', unitType: 'Sachet', costPrice: 750, retailPrice: 1200, wholesalePrice: 1000, stock: 120, barcode: '1006' }
    ]);
  }
}

// Disabled — real drug data now lives in Supabase (populated via CSV
// import) and is pulled down by syncDrugsFromCloud() on load. Leaving
// this active would reseed the six sample drugs on any device with an
// empty local database.
// ensureSeedData();

// Supabase/PostgREST caps every request at 1000 rows by default, silently
// — a plain .select('*') on a catalog bigger than that would only ever
// pull the first 1000 drugs, with no error to warn you. This pages
// through the table with .range() until a page comes back short of
// PAGE_SIZE, so the full catalog syncs down regardless of size.
const DRUGS_SYNC_PAGE_SIZE = 1000;

export function mapCloudDrug(drug) {
  return {
          id: String(drug.id),
          name: drug.name,
          unitType: drug.unit_type || drug.unitType || 'Sachet',
          costPrice: Number(drug.cost_price ?? drug.costPrice ?? 0),
          retailPrice: Number(drug.retail_price ?? drug.retailPrice ?? 0),
          wholesalePrice: Number(drug.wholesale_price ?? drug.wholesalePrice ?? 0),
          stock: Number(drug.stock ?? 0),
          barcode: drug.barcode || '',
          halfPackQty:
            drug.half_pack_qty ?? drug.halfPackQty ?? null,
          halfPackPrice:
            drug.half_pack_price ?? drug.halfPackPrice ?? null,
          packQty: drug.pack_qty ?? drug.packQty ?? null,
          packPrice: drug.pack_price ?? drug.packPrice ?? null,
          // Both optional — the standard minimum quantity a shelf should
          // never fall below, and how many to buy when it's time to
          // restock. Either can be left blank; the purchase-list
          // generator just works with whatever's actually filled in.
          minStockQty: drug.min_stock_qty ?? drug.minStockQty ?? null,
          recommendedPurchaseQty:
            drug.recommended_purchase_qty ?? drug.recommendedPurchaseQty ?? null,
          // Past (costPrice, retailPrice, wholesalePrice) choices for this
          // specific drug — feeds getPriceRecommendation() so the % profit
          // suggested next time reflects what was actually chosen before,
          // not just the generic default.
          priceHistory: drug.price_history ?? drug.priceHistory ?? [],
          deletedAt: drug.deleted_at || drug.deletedAt || null,
          deletedBy: drug.deleted_by || drug.deletedBy || null,
          counterSpace: drug.counter_space ?? drug.counterSpace ?? '',
  synced: 1
  };
}

// Pulls a single drug row pushed by Realtime into the local table.
export async function applyRealtimeDrugRow(row) {
  try {
    if (!row || row.id === undefined) return;
    const existing = await db.drugs.get(String(row.id));
    if (existing && Number(existing.synced) === 0) return;
    await db.drugs.put(mapCloudDrug(row));
  } catch (err) {
    console.warn('Realtime drug apply failed:', err.message);
  }
}

export async function syncDrugsFromCloud() {
  try {
    let allCloudDrugs = [];
    let from = 0;

    while (true) {
      const { data: page, error } = await supabase
        .from('drugs')
        .select('*')
        .range(from, from + DRUGS_SYNC_PAGE_SIZE - 1);

      if (error) throw error;
      if (!page || page.length === 0) break;

      allCloudDrugs = allCloudDrugs.concat(page);

      if (page.length < DRUGS_SYNC_PAGE_SIZE) break;
      from += DRUGS_SYNC_PAGE_SIZE;
    }

    if (allCloudDrugs.length > 0) {
      // Don't let a pull-from-cloud stomp a drug this device just created
      // or edited and hasn't successfully pushed up yet (synced: 0) — a
      // bulkPut here would overwrite it with stale/missing cloud data
      // before syncPendingDrugsToCloud() gets a chance to retry the push.
      const pendingIds = new Set(
        (await db.drugs.where('synced').equals(0).toArray()).map((d) =>
          String(d.id)
        )
      );

      const mappedDrugs = allCloudDrugs
        .filter((drug) => !pendingIds.has(String(drug.id)))
        .map(mapCloudDrug);

      if (mappedDrugs.length > 0) {
        await db.drugs.bulkPut(mappedDrugs);
      }
    }
  } catch (err) {
    console.warn('Unable to sync drugs from cloud:', err.message);
  }
}

// Mirrors syncPendingSalesToCloud(): retries the cloud upsert for any
// drug that was saved locally (synced: 0) but whose push to Supabase
// failed at the time — weak signal, a dropped connection, etc. Runs on
// every reconnect/app-load alongside the sales and audit-log retries.
export async function syncPendingDrugsToCloud() {
  try {
    const unsyncedDrugs = await db.drugs.where('synced').equals(0).toArray();
    if (unsyncedDrugs.length === 0) return;

    for (const drug of unsyncedDrugs) {
      const row = {
        id: drug.id,
        name: drug.name,
        unit_type: drug.unitType,
        cost_price: drug.costPrice,
        retail_price: drug.retailPrice,
        wholesale_price: drug.wholesalePrice,
        stock: drug.stock,
        barcode: drug.barcode,
        half_pack_qty: drug.halfPackQty ?? null,
        half_pack_price: drug.halfPackPrice ?? null,
        pack_qty: drug.packQty ?? null,
        pack_price: drug.packPrice ?? null,
        min_stock_qty: drug.minStockQty ?? null,
        recommended_purchase_qty: drug.recommendedPurchaseQty ?? null,
        price_history: drug.priceHistory ?? [],
        counter_space: drug.counterSpace ?? ''
      };
      let { error } = await supabase.from('drugs').upsert([row]);
      // If migration v18 hasn't been run yet the counter_space column
      // doesn't exist — retry without it so drug sync never stalls.
      if (error && /counter_space/i.test(error.message || '')) {
        const { counter_space, ...rowWithoutCounter } = row;
        ({ error } = await supabase.from('drugs').upsert([rowWithoutCounter]));
      }

      if (!error) {
        await db.drugs.update(drug.id, { synced: 1 });
      }
    }
  } catch (err) {
    console.warn('Unable to sync pending drugs:', err.message);
  }
}

// ============================================================
// CSV / EXCEL DRUG IMPORT
// ------------------------------------------------------------
// Bulk create/update drugs from a parsed spreadsheet (App.jsx does the
// actual file reading with the `xlsx` library and hands this plain
// row objects — this function never touches File/ArrayBuffer stuff).
// Manager/administrator only — this bypasses the cashier-needs-
// approval queue entirely, the same way the rest of the app only lets
// a manager/administrator's own drug edits apply immediately.
//
// A row matches an existing drug by barcode first (if the row has a
// non-blank barcode and it matches one on file), then by exact
// (case-insensitive) name. Any field left blank in the row is simply
// not touched on an existing drug; a brand-new drug needs at least a
// name to be created at all.
// ============================================================

const DRUG_IMPORT_HEADER_ALIASES = {
  name: ['name', 'drugname', 'drug'],
  unitType: ['unittype', 'unit', 'type'],
  costPrice: ['costprice', 'cost'],
  retailPrice: ['retailprice', 'retail'],
  wholesalePrice: ['wholesaleprice', 'wholesale'],
  stock: ['stock', 'quantity', 'qty'],
  barcode: ['barcode', 'code'],
  minStockQty: ['minstockqty', 'minstock', 'minimumstock'],
  recommendedPurchaseQty: ['recommendedpurchaseqty', 'recommendedqty', 'purchaseqty'],
  halfPackQty: ['halfpackqty', 'halfpack'],
  halfPackPrice: ['halfpackprice'],
  packQty: ['packqty', 'pack'],
  packPrice: ['packprice'],
  counterSpace: ['counterspace', 'spaceonthecounter', 'counter', 'shelf', 'location', 'counterlocation']
};

function normalizeHeaderKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Maps one raw spreadsheet row (arbitrary header casing/spacing) onto
// our internal field names, ignoring any column it doesn't recognize.
function normalizeImportRow(row) {
  const out = {};
  const rowKeys = Object.keys(row || {});
  for (const [field, aliases] of Object.entries(DRUG_IMPORT_HEADER_ALIASES)) {
    const matchKey = rowKeys.find((k) => aliases.includes(normalizeHeaderKey(k)));
    if (matchKey !== undefined && String(row[matchKey]).trim() !== '') {
      out[field] = row[matchKey];
    }
  }
  return out;
}

// ============================================================
// BULK IMPORT FOR SUPPLIERS / CUSTOMERS / BANK OPTIONS
// (managers + administrators; bank options administrator-only)
// A row matches an existing record by name (case-insensitive); blank
// cells leave existing values untouched. New wholesale customers start
// at the balance in the row (opening balance) — existing customers'
// balances are NEVER changed by an import, since balances are driven by
// sales, payments and returns.
// ============================================================
function normalizeRowWith(row, aliasMap) {
  const out = {};
  const rowKeys = Object.keys(row || {});
  for (const [field, aliases] of Object.entries(aliasMap)) {
    const matchKey = rowKeys.find((k) => aliases.includes(normalizeHeaderKey(k)));
    if (matchKey !== undefined && String(row[matchKey]).trim() !== '') {
      out[field] = row[matchKey];
    }
  }
  return out;
}

const SUPPLIER_IMPORT_ALIASES = {
  name: ['name', 'suppliername', 'supplier', 'company'],
  contactPerson: ['contactperson', 'contact', 'contactname'],
  phone: ['phone', 'phonenumber', 'tel', 'mobile'],
  email: ['email', 'emailaddress'],
  address: ['address', 'location']
};

const CUSTOMER_IMPORT_ALIASES = {
  name: ['name', 'customername', 'fullname', 'customer'],
  phones: ['phones', 'phone', 'phonenumber', 'phonenumbers', 'tel', 'mobile'],
  email: ['email', 'emailaddress'],
  address: ['address', 'location'],
  balance: ['balance', 'openingbalance', 'owing', 'owes']
};

function requireManagerForImport(actor, label) {
  const role = actor?.role;
  if (!(role === 'manager' || role === 'administrator')) {
    return { success: false, reason: `Only managers and administrators can import ${label}.` };
  }
  return null;
}

export async function bulkImportSuppliers(rows, actor) {
  const denied = requireManagerForImport(actor, 'suppliers');
  if (denied) return denied;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { success: false, reason: 'Nothing to import — the file had no usable rows.' };
  }
  try {
    const existing = (await db.suppliers.toArray()).filter((s) => !s.deletedAt);
    const byName = new Map(existing.map((s) => [String(s.name).trim().toLowerCase(), s]));
    let created = 0;
    let updated = 0;
    const skipped = [];
    const toPut = [];

    rows.forEach((raw, index) => {
      const row = normalizeRowWith(raw, SUPPLIER_IMPORT_ALIASES);
      const name = row.name ? String(row.name).trim() : '';
      if (!name) {
        skipped.push({ row: index + 1, reason: 'No supplier name.' });
        return;
      }
      const match = byName.get(name.toLowerCase());
      const fields = {};
      ['contactPerson', 'phone', 'email', 'address'].forEach((f) => {
        if (row[f] !== undefined) fields[f] = String(row[f]).trim();
      });
      if (match) {
        const merged = { ...match, ...fields, synced: 0 };
        toPut.push(merged);
        byName.set(name.toLowerCase(), merged);
        updated += 1;
      } else {
        const fresh = {
          id: generateId('SUPPLIER'),
          name,
          contactPerson: '',
          phone: '',
          email: '',
          address: '',
          ...fields,
          synced: 0
        };
        toPut.push(fresh);
        byName.set(name.toLowerCase(), fresh);
        created += 1;
      }
    });

    if (toPut.length > 0) await db.suppliers.bulkPut(toPut);
    if (navigator.onLine) await syncPendingSuppliersToCloud();

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'suppliers_imported',
      targetType: 'supplier',
      targetId: 'bulk',
      details: { created, updated, skipped: skipped.length }
    });
    return { success: true, created, updated, skipped };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

export async function bulkImportCustomers(rows, actor) {
  const denied = requireManagerForImport(actor, 'customers');
  if (denied) return denied;
  if (!Array.isArray(rows) || rows.length === 0) {
    return { success: false, reason: 'Nothing to import — the file had no usable rows.' };
  }
  try {
    const existing = (await db.customers.toArray()).filter((c) => !c.deletedAt);
    const byName = new Map(existing.map((c) => [String(c.name).trim().toLowerCase(), c]));
    let created = 0;
    let updated = 0;
    const skipped = [];
    const toPut = [];

    rows.forEach((raw, index) => {
      const row = normalizeRowWith(raw, CUSTOMER_IMPORT_ALIASES);
      const name = row.name ? String(row.name).trim() : '';
      if (!name) {
        skipped.push({ row: index + 1, reason: 'No customer name.' });
        return;
      }
      // Several numbers can share one cell, separated by ; , or /
      const phones = row.phones
        ? String(row.phones)
            .split(/[;,/]/)
            .map((p) => p.trim())
            .filter(Boolean)
        : null;
      const match = byName.get(name.toLowerCase());

      if (match) {
        const merged = {
          ...match,
          ...(phones ? { phones, phone: phones[0] || '' } : {}),
          ...(row.email !== undefined ? { email: String(row.email).trim() } : {}),
          ...(row.address !== undefined ? { address: String(row.address).trim() } : {}),
          synced: 0
        };
        toPut.push(merged);
        byName.set(name.toLowerCase(), merged);
        updated += 1;
      } else {
        const openingBalance = Number(row.balance);
        const fresh = {
          id: generateId('CUSTOMER'),
          name,
          phones: phones || [],
          phone: (phones && phones[0]) || '',
          email: row.email !== undefined ? String(row.email).trim() : '',
          address: row.address !== undefined ? String(row.address).trim() : '',
          balance: Number.isFinite(openingBalance) ? openingBalance : 0,
          balanceDirty: 1,
          synced: 0
        };
        toPut.push(fresh);
        byName.set(name.toLowerCase(), fresh);
        created += 1;
      }
    });

    if (toPut.length > 0) await db.customers.bulkPut(toPut);
    if (navigator.onLine) await syncPendingCustomersToCloud();

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'customers_imported',
      targetType: 'customer',
      targetId: 'bulk',
      details: { created, updated, skipped: skipped.length }
    });
    return { success: true, created, updated, skipped };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

export async function bulkImportBankOptions(rows, actor) {
  if (actor?.role !== 'administrator') {
    return { success: false, reason: 'Only an administrator can import bank options.' };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { success: false, reason: 'Nothing to import — the file had no usable rows.' };
  }
  try {
    const existing = await db.bankOptions.toArray();
    const names = new Set(existing.map((b) => String(b.name).trim().toLowerCase()));
    let created = 0;
    const skipped = [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = normalizeRowWith(rows[i], {
        name: ['name', 'bank', 'bankname'],
        color: ['color', 'colour']
      });
      const name = row.name ? String(row.name).trim() : '';
      if (!name) {
        skipped.push({ row: i + 1, reason: 'No bank name.' });
        continue;
      }
      if (names.has(name.toLowerCase())) {
        skipped.push({ row: i + 1, reason: `"${name}" already exists.` });
        continue;
      }
      await addBankOption(name, actor, row.color ? String(row.color).trim() : undefined);
      names.add(name.toLowerCase());
      created += 1;
    }
    return { success: true, created, updated: 0, skipped };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

export async function bulkImportDrugs(rows, actor) {
  const role = actor?.role;
  if (!(role === 'manager' || role === 'administrator')) {
    return { success: false, reason: 'Only managers and administrators can import drugs.' };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { success: false, reason: 'Nothing to import — the file had no usable rows.' };
  }

  try {
    const existingDrugs = await db.drugs.toArray();
    const byBarcode = new Map();
    const byName = new Map();
    existingDrugs.forEach((d) => {
      if (d.deletedAt) return;
      if (d.barcode) byBarcode.set(String(d.barcode).trim(), d);
      byName.set(String(d.name).trim().toLowerCase(), d);
    });

    let created = 0;
    let updated = 0;
    const skipped = [];
    const toPut = [];
    const priceChoices = [];

    rows.forEach((raw, index) => {
      const row = normalizeImportRow(raw);
      const barcode = row.barcode ? String(row.barcode).trim() : '';
      const name = row.name ? String(row.name).trim() : '';

      const existing = (barcode && byBarcode.get(barcode)) ||
        (name && byName.get(name.toLowerCase())) ||
        null;

      const optionalNumber = (value) =>
        value === undefined || value === '' ? undefined : Number(value);

      if (existing) {
        const changes = { synced: 0 };
        [
          'name', 'unitType', 'costPrice', 'retailPrice', 'wholesalePrice',
          'stock', 'barcode'
        ].forEach((field) => {
          if (row[field] !== undefined) {
            changes[field] = field === 'name' || field === 'unitType' || field === 'barcode'
              ? String(row[field]).trim()
              : Number(row[field]);
          }
        });
        [
          'minStockQty', 'recommendedPurchaseQty',
          'halfPackQty', 'halfPackPrice', 'packQty', 'packPrice'
        ].forEach((field) => {
          const n = optionalNumber(row[field]);
          if (n !== undefined) changes[field] = n;
        });
        if (row.counterSpace !== undefined && String(row.counterSpace).trim() !== '') {
          changes.counterSpace = String(row.counterSpace).trim();
        }
        const merged = { ...existing, ...changes };
        toPut.push(merged);
        if (merged.costPrice > 0 && (merged.retailPrice > 0 || merged.wholesalePrice > 0)) {
          priceChoices.push(merged);
        }
        updated += 1;
      } else if (name) {
        const costPrice = Number(row.costPrice) || 0;
        const retailPrice = Number(row.retailPrice) || 0;
        const wholesalePrice = Number(row.wholesalePrice) || 0;
        const newDrug = {
          id: generateId('DRUG'),
          name,
          unitType: row.unitType ? String(row.unitType).trim() : 'Unit',
          costPrice,
          retailPrice,
          wholesalePrice,
          stock: Math.max(0, Number(row.stock) || 0),
          barcode,
          halfPackQty: optionalNumber(row.halfPackQty) ?? null,
          halfPackPrice: optionalNumber(row.halfPackPrice) ?? null,
          packQty: optionalNumber(row.packQty) ?? null,
          packPrice: optionalNumber(row.packPrice) ?? null,
          minStockQty: optionalNumber(row.minStockQty) ?? null,
          recommendedPurchaseQty: optionalNumber(row.recommendedPurchaseQty) ?? null,
          counterSpace: row.counterSpace ? String(row.counterSpace).trim() : '',
          priceHistory: [],
          synced: 0
        };
        toPut.push(newDrug);
        if (costPrice > 0 && (retailPrice > 0 || wholesalePrice > 0)) {
          priceChoices.push(newDrug);
        }
        byName.set(name.toLowerCase(), newDrug);
        if (barcode) byBarcode.set(barcode, newDrug);
        created += 1;
      } else {
        skipped.push({ row: index + 1, reason: 'No name and no matching existing drug (by barcode or name).' });
      }
    });

    if (toPut.length > 0) {
      await db.drugs.bulkPut(toPut);
    }

    for (const d of priceChoices) {
      recordDrugPriceChoice(d.id, d.costPrice, d.retailPrice, d.wholesalePrice).catch(() => {});
    }

    if (navigator.onLine) {
      syncPendingDrugsToCloud().catch((err) =>
        console.warn('Background import cloud sync failed:', err.message)
      );
    }

    await logAuditEvent({
      action: 'drugs_bulk_imported',
      actorEmail: actor?.email,
      actorRole: actor?.role,
      details: { created, updated, skippedCount: skipped.length }
    });

    return { success: true, created, updated, skipped };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ============================================================
// PRICE RECOMMENDATION ENGINE
// ------------------------------------------------------------
// Pure, synchronous — no db access, safe to call on every keystroke
// for a live "as you type the cost price" suggestion.
//
// Below ₦10,000 cost, wholesale defaults to ~10% profit and retail to
// ~30%, each independently rounded UP to a tidy price. Above ₦10,000,
// wholesale and retail collapse into a single price in the 15%-35%
// range (default 25%).
//
// Either side, if this specific drug has price history (past times
// its cost/retail/wholesale were actually saved), the AVERAGE % profit
// actually chosen for it is used instead of the generic default — the
// software learning what this particular pharmacy tends to charge for
// this particular drug, rather than applying one blanket rule to
// everything.
// ============================================================

// Rounds a price UP to a tidy figure, with the rounding unit chosen
// from the COST price's own size (not the computed sale price) — a
// ₦50 drug rounds to the nearest ₦10, a ₦500 drug to the nearest
// ₦100, anything ₦1,000 and up to the nearest ₦1,000.
function roundSalePriceUp(rawPrice, costPrice) {
  const unit = costPrice < 100 ? 10 : costPrice < 1000 ? 100 : 1000;
  return Math.ceil(rawPrice / unit) * unit;
}

// Average % profit, (price - cost) / cost * 100, actually chosen in
// the past — wholesale and retail tracked separately since a drug's
// history may only have one or the other filled in on some entries.
function averageLearnedPercents(priceHistory) {
  if (!Array.isArray(priceHistory) || priceHistory.length === 0) {
    return { wholesalePercent: null, retailPercent: null };
  }
  let wTotal = 0, wCount = 0, rTotal = 0, rCount = 0;
  for (const entry of priceHistory) {
    const cost = Number(entry.costPrice) || 0;
    if (cost <= 0) continue;
    const wholesale = Number(entry.wholesalePrice) || 0;
    const retail = Number(entry.retailPrice) || 0;
    if (wholesale > 0) {
      wTotal += ((wholesale - cost) / cost) * 100;
      wCount += 1;
    }
    if (retail > 0) {
      rTotal += ((retail - cost) / cost) * 100;
      rCount += 1;
    }
  }
  return {
    wholesalePercent: wCount > 0 ? wTotal / wCount : null,
    retailPercent: rCount > 0 ? rTotal / rCount : null
  };
}

// The generic defaults used when there's no admin-saved pricing
// setting yet (brand-new install) and no per-drug learned history —
// exactly the percentages the pharmacy was already using by hand: 10%
// wholesale / 30% retail under ₦10,000, and a single 15%-35% (default
// 25%) price at or above it.
export const DEFAULT_PRICING_SETTINGS = {
  wholesalePercent: 10,
  retailPercent: 30,
  highValueThreshold: 10000,
  highValuePercent: 25,
  highValueMinPercent: 15,
  highValueMaxPercent: 35
};

// Returns null when the cost price isn't a usable positive number yet
// (so the UI can simply not show a recommendation). Otherwise:
// { wholesale, retail, wholesalePercent, retailPercent, sameForBoth, source }
// `source` is 'learned' when at least one side came from this drug's
// own history, 'default' when both sides used the generic rule.
//
// `settings` is the admin-editable general recommendation (see
// fetchPricingSettings/savePricingSettings below) — pass the live
// settings row so an admin's change to "general recommended profit %"
// takes effect everywhere immediately. Falls back to
// DEFAULT_PRICING_SETTINGS when not supplied (keeps every existing
// call site working without a settings object).
export function getPriceRecommendation(costPrice, priceHistory, settings) {
  const cost = Number(costPrice) || 0;
  if (cost <= 0) return null;

  const s = { ...DEFAULT_PRICING_SETTINGS, ...(settings || {}) };

  const learned = averageLearnedPercents(priceHistory);
  const hasLearned = learned.wholesalePercent != null || learned.retailPercent != null;

  if (cost > s.highValueThreshold) {
    // High-value drugs: one price serves both sale types, and the
    // "normal" range widens (default 15%-35%, 25% default) rather than
    // the fixed wholesale/retail split used below the threshold.
    const learnedPercent = learned.retailPercent ?? learned.wholesalePercent;
    const percent = learnedPercent != null
      ? Math.min(s.highValueMaxPercent, Math.max(s.highValueMinPercent, learnedPercent))
      : s.highValuePercent;
    const rounded = roundSalePriceUp(cost * (1 + percent / 100), cost);
    return {
      wholesale: rounded,
      retail: rounded,
      wholesalePercent: percent,
      retailPercent: percent,
      sameForBoth: true,
      source: learnedPercent != null ? 'learned' : 'default'
    };
  }

  const wholesalePercent = learned.wholesalePercent ?? s.wholesalePercent;
  const retailPercent = learned.retailPercent ?? s.retailPercent;

  return {
    wholesale: roundSalePriceUp(cost * (1 + wholesalePercent / 100), cost),
    retail: roundSalePriceUp(cost * (1 + retailPercent / 100), cost),
    wholesalePercent,
    retailPercent,
    sameForBoth: false,
    source: hasLearned ? 'learned' : 'default'
  };
}

// Called whenever a drug's cost/retail/wholesale prices are actually
// saved (the Drugs CRUD form, or a restock line, new or existing drug)
// — appends one entry to that drug's price history so future
// recommendations for THIS drug can learn from what was really chosen,
// not just the generic default percentages. Keeps only the most
// recent 20 entries; that's plenty to average over.
export async function recordDrugPriceChoice(drugId, costPrice, retailPrice, wholesalePrice) {
  try {
    const cost = Number(costPrice) || 0;
    const retail = Number(retailPrice) || 0;
    const wholesale = Number(wholesalePrice) || 0;
    if (cost <= 0 || (retail <= 0 && wholesale <= 0)) return;

    const drug = await db.drugs.get(drugId);
    if (!drug) return;

    const history = Array.isArray(drug.priceHistory) ? drug.priceHistory : [];
    const entry = {
      costPrice: cost,
      retailPrice: retail,
      wholesalePrice: wholesale,
      recordedAt: new Date().toISOString()
    };
    const updatedHistory = [...history, entry].slice(-20);

    await db.drugs.update(drugId, { priceHistory: updatedHistory, synced: 0 });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('drugs')
          .update({ price_history: updatedHistory })
          .eq('id', drugId);
        if (!error) await db.drugs.update(drugId, { synced: 1 });
      } catch (err) {
        console.warn('Cloud price-history update postponed:', err.message);
      }
    }
  } catch (err) {
    console.warn('Unable to record price choice:', err.message);
  }
}

// ============================================================
// APP SETTINGS
// A small generic key/value store (schema v15's `settings` table and
// the Supabase `app_settings` table) — currently holds just the
// pricing-recommendation percentages, admin-editable from the
// Dashboard's Pricing Settings panel and picked up everywhere
// getPriceRecommendation is called.
// ============================================================

export async function fetchPricingSettings() {
  try {
    const row = await db.settings.get('pricing');
    if (navigator.onLine) {
      try {
        const { data, error } = await supabase
          .from('app_settings')
          .select('*')
          .eq('key', 'pricing')
          .maybeSingle();
        if (!error && data) {
          const merged = { ...DEFAULT_PRICING_SETTINGS, ...(data.value || {}) };
          await db.settings.put({ key: 'pricing', ...merged, synced: 1 });
          return merged;
        }
      } catch (err) {
        console.warn('Cloud pricing-settings fetch failed, using local copy:', err.message);
      }
    }
    if (row) {
      const { key, synced, ...values } = row;
      return { ...DEFAULT_PRICING_SETTINGS, ...values };
    }
    return { ...DEFAULT_PRICING_SETTINGS };
  } catch (err) {
    console.warn('Unable to fetch pricing settings, using defaults:', err.message);
    return { ...DEFAULT_PRICING_SETTINGS };
  }
}

export async function savePricingSettings(settings, actor) {
  try {
    const merged = { ...DEFAULT_PRICING_SETTINGS, ...settings };
    await db.settings.put({ key: 'pricing', ...merged, synced: 0 });

    if (navigator.onLine) {
      try {
        const { error } = await supabase.from('app_settings').upsert([
          {
            key: 'pricing',
            value: merged,
            updated_at: new Date().toISOString(),
            updated_by_email: actor?.email || null
          }
        ]);
        if (!error) await db.settings.update('pricing', { synced: 1 });
      } catch (err) {
        console.warn('Cloud pricing-settings save postponed:', err.message);
      }
    }

    await logAuditEvent({
      action: 'pricing_settings_updated',
      actorEmail: actor?.email,
      actorRole: actor?.role,
      details: merged
    });

    return { success: true, settings: merged };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

export async function syncPendingSettingsToCloud() {
  try {
    const pending = await db.settings.where('synced').equals(0).toArray();
    if (pending.length === 0) return;
    for (const row of pending) {
      const { key, synced, ...values } = row;
      try {
        const { error } = await supabase.from('app_settings').upsert([
          { key, value: values, updated_at: new Date().toISOString() }
        ]);
        if (!error) await db.settings.update(key, { synced: 1 });
      } catch (err) {
        console.warn(`Cloud settings sync postponed for "${key}":`, err.message);
      }
    }
  } catch (err) {
    console.warn('Unable to sync pending settings:', err.message);
  }
}

// ============================================================
// ROLE MANAGEMENT
// ------------------------------------------------------------
// Online-only (acting on other people's live accounts isn't something
// that makes sense to queue offline) — lists every Supabase `profiles`
// row and lets an administrator change one's role directly from the
// UI instead of needing to open Supabase. Like every other table in
// this app, `profiles` trusts the client's own role check rather than
// enforcing it in RLS, so this is gated to administrator-only in the
// UI (App.jsx) as well as here.
// ============================================================

export async function fetchAllProfiles() {
  try {
    const { data, error } = await supabase.from('profiles').select('*');
    if (error) throw error;
    const profiles = (data || []).slice().sort((a, b) => {
      const aLabel = (a.full_name || a.email || a.id || '').toLowerCase();
      const bLabel = (b.full_name || b.email || b.id || '').toLowerCase();
      return aLabel.localeCompare(bLabel);
    });
    return { success: true, profiles };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// Lightweight directory (id, email, previous emails, full name, role,
// active flag) used everywhere a record shows who did something. Cached
// in localStorage so names still show while offline.
const PROFILE_DIRECTORY_CACHE_KEY = 'azu_profile_directory_v1';

export function readCachedProfileDirectory() {
  try {
    const raw = localStorage.getItem(PROFILE_DIRECTORY_CACHE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function fetchProfileDirectory() {
  try {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name, role, is_active, previous_emails');
    if (error) throw error;
    const rows = data || [];
    try {
      localStorage.setItem(PROFILE_DIRECTORY_CACHE_KEY, JSON.stringify(rows));
    } catch {
      /* storage unavailable — fine */
    }
    return rows;
  } catch (err) {
    console.warn('Unable to load profile directory:', err.message);
    return null;
  }
}

// A role other than administrator can be changed by an administrator
// from the app. Changing an ADMINISTRATOR's role — or promoting anyone
// to administrator — is deliberately blocked here, in the UI, and by a
// database trigger (migration v18): it can only be done directly in
// Supabase.
export async function updateUserRole(profileId, newRole, actor) {
  if (actor?.role !== 'administrator') {
    return { success: false, reason: 'Only an administrator can change account roles.' };
  }
  if (!ROLE_RANK.hasOwnProperty(newRole)) {
    return { success: false, reason: `"${newRole}" isn't a recognized role.` };
  }
  if (newRole === 'administrator') {
    return {
      success: false,
      reason: 'Administrator roles can only be granted directly in Supabase.'
    };
  }
  try {
    const { data: target, error: lookupError } = await supabase
      .from('profiles')
      .select('id, role')
      .eq('id', profileId)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!target) return { success: false, reason: 'Account not found.' };
    if (target.role === 'administrator') {
      return {
        success: false,
        reason:
          "An administrator's role can only be changed directly in Supabase."
      };
    }

    const { error } = await supabase
      .from('profiles')
      .update({ role: newRole })
      .eq('id', profileId);
    if (error) throw error;

    await logAuditEvent({
      action: 'user_role_changed',
      actorEmail: actor?.email,
      actorRole: actor?.role,
      targetType: 'profile',
      targetId: profileId,
      details: { newRole }
    });

    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ------------------------------------------------------------
// ACCOUNT MANAGEMENT (administrator-only, via the `admin-users` Edge
// Function — it holds the service-role key; the browser never does).
// ------------------------------------------------------------
async function callAdminUsers(payload, actor, auditAction, auditTarget, auditDetails) {
  if (actor?.role !== 'administrator') {
    return { success: false, reason: 'Only an administrator can manage accounts.' };
  }
  try {
    const { data, error } = await supabase.functions.invoke('admin-users', {
      body: payload
    });
    if (error) {
      // supabase-js hides the function's JSON error body inside the
      // error's `context` response — dig it out so the real reason shows.
      let message = error.message;
      try {
        const body = await error.context?.json?.();
        if (body?.error) message = body.error;
      } catch {
        /* keep generic message */
      }
      if (/Failed to send a request|not found|404/i.test(message || '')) {
        message =
          'The account-management function is not deployed yet (see SETUP_NOTES.md). ' + message;
      }
      return { success: false, reason: message };
    }
    if (data?.error) return { success: false, reason: data.error };

    await logAuditEvent({
      action: auditAction,
      actorEmail: actor?.email,
      actorRole: actor?.role,
      targetType: 'profile',
      targetId: auditTarget || data?.id || null,
      // Never log passwords.
      details: auditDetails || {}
    });
    return { success: true, ...data };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

export function createAccount({ email, fullName, password, role }, actor) {
  return callAdminUsers(
    { action: 'create', email, fullName, password, role },
    actor,
    'account_created',
    null,
    { email, fullName, role }
  );
}

export function updateAccountDetails(id, { fullName, email, role }, actor) {
  return callAdminUsers(
    { action: 'update', id, fullName, email, role },
    actor,
    'account_updated',
    id,
    { fullName, email, role }
  );
}

export function setAccountPassword(id, password, actor) {
  return callAdminUsers(
    { action: 'set_password', id, password },
    actor,
    'account_password_set',
    id,
    {}
  );
}

export function setAccountActive(id, active, actor) {
  return callAdminUsers(
    { action: 'set_active', id, active },
    actor,
    active ? 'account_reactivated' : 'account_deactivated',
    id,
    {}
  );
}

export async function syncPendingSalesToCloud() {
  try {
    const unsyncedSales = await db.sales.where('synced').equals(0).toArray();
    if (unsyncedSales.length === 0) return;

    for (const sale of unsyncedSales) {
      // Full field list — this retry path used to send only a handful
      // of columns, so a sale that had to be retried lost its attendant,
      // wholesale customer, amount paid and balance snapshot in the cloud.
      let { error } = await supabase.from('sales').upsert([
        {
          id: sale.id,
          total: sale.total,
          sale_type: sale.saleType,
          cashier_id: sale.cashierId || null,
          cashier_email: sale.cashierEmail || null,
          attendant_id: sale.attendantId || null,
          attendant_email: sale.attendantEmail || null,
          customer_name: sale.customerName,
          customer_phone: sale.customerPhone,
          customer_id: sale.customerId || null,
          amount_paid: sale.amountPaid ?? null,
          customer_balance_before: sale.customerBalanceBefore ?? null,
          customer_balance_after: sale.customerBalanceAfter ?? null,
          items: sale.items,
          payment_method: sale.paymentMethod ?? null,
          ticket_id: sale.ticketId || null,
          reversal_log: sale.reversalLog ?? null,
          created_at: sale.createdAt
        }
      ]);

      if (!error) {
        await db.sales.update(sale.id, { synced: 1 });
      }
    }
  } catch (err) {
    console.warn('Unable to sync pending sales:', err.message);
  }
}

// Automatically purge offline sales older than 1 year (365 days)
export async function pruneSalesOlderThanOneYear() {
  try {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const cutoffDate = oneYearAgo.toISOString();

    const oldSales = await db.sales.where('createdAt').below(cutoffDate).toArray();
    if (oldSales.length > 0) {
      const idsToDelete = oldSales.map((s) => s.id);
      await db.sales.bulkDelete(idsToDelete);
      console.log(`Pruned ${idsToDelete.length} sales records older than 1 year.`);
    }
  } catch (err) {
    console.warn('Error pruning old sales:', err.message);
  }
}

// ============================================================
// AUDIT LOG
// Every sensitive manager/administrator action writes one entry
// here. Written locally first (so it's never lost offline), then
// pushed to Supabase when possible.
// ============================================================
export async function logAuditEvent({ actorEmail, actorRole, action, targetType, targetId, details }) {
  const entry = {
    id: generateId('LOG'),
    actorEmail: actorEmail || 'unknown',
    actorRole: actorRole || 'unknown',
    action,
    targetType: targetType || '',
    targetId: targetId ? String(targetId) : '',
    details: details ? JSON.stringify(details) : '',
    createdAt: new Date().toISOString(),
    synced: 0
  };

  try {
    await db.auditLog.add(entry);
  } catch (err) {
    console.warn('Unable to write audit log entry locally:', err.message);
  }

  if (navigator.onLine) {
    try {
      const { error } = await supabase.from('audit_log').insert([
        {
          id: entry.id,
          actor_email: entry.actorEmail,
          actor_role: entry.actorRole,
          action: entry.action,
          target_type: entry.targetType,
          target_id: entry.targetId,
          details: entry.details ? JSON.parse(entry.details) : null,
          created_at: entry.createdAt
        }
      ]);
      if (!error) {
        await db.auditLog.update(entry.id, { synced: 1 });
      }
    } catch (err) {
      console.warn('Audit log cloud sync deferred:', err.message);
    }
  }

  return entry;
}

export async function syncAuditLogToCloud() {
  try {
    const pending = await db.auditLog.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const entry of pending) {
      const { error } = await supabase.from('audit_log').insert([
        {
          id: entry.id,
          actor_email: entry.actorEmail,
          actor_role: entry.actorRole,
          action: entry.action,
          target_type: entry.targetType,
          target_id: entry.targetId,
          details: entry.details ? JSON.parse(entry.details) : null,
          created_at: entry.createdAt
        }
      ]);
      if (!error) {
        await db.auditLog.update(entry.id, { synced: 1 });
      }
    }
  } catch (err) {
    console.warn('Unable to sync audit log:', err.message);
  }
}

// ============================================================
// DRUG SOFT-DELETE / RECOVERY (administrator feature)
// A manager's "delete" only sets deletedAt/deletedBy — the row
// stays in place so an administrator can restore it, or remove
// it for good with permanentlyDeleteDrug.
// ============================================================
export async function softDeleteDrug(id, actor) {
  try {
    const drugKey = String(id);
    const existing = (await db.drugs.get(drugKey)) || (await db.drugs.get(Number(id)));
    if (!existing) return;

    const deletedAt = new Date().toISOString();
    const deletedBy = actor?.email || 'unknown';

    await db.drugs.update(existing.id, { deletedAt, deletedBy });

    if (navigator.onLine) {
      try {
        await supabase
          .from('drugs')
          .update({ deleted_at: deletedAt, deleted_by: deletedBy })
          .eq('id', drugKey);
      } catch (err) {
        console.warn('Cloud soft-delete postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'drug_deleted',
      targetType: 'drug',
      targetId: drugKey,
      details: { name: existing.name }
    });
  } catch (err) {
    console.warn('Unable to soft-delete drug:', err.message);
  }
}

export async function restoreDrug(id, actor) {
  try {
    const drugKey = String(id);
    const existing = (await db.drugs.get(drugKey)) || (await db.drugs.get(Number(id)));
    if (!existing) return;

    await db.drugs.update(existing.id, { deletedAt: null, deletedBy: null });

    if (navigator.onLine) {
      try {
        await supabase
          .from('drugs')
          .update({ deleted_at: null, deleted_by: null })
          .eq('id', drugKey);
      } catch (err) {
        console.warn('Cloud restore postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'drug_restored',
      targetType: 'drug',
      targetId: drugKey,
      details: { name: existing.name }
    });
  } catch (err) {
    console.warn('Unable to restore drug:', err.message);
  }
}

export async function permanentlyDeleteDrug(id, actor) {
  try {
    const drugKey = String(id);
    const existing = (await db.drugs.get(drugKey)) || (await db.drugs.get(Number(id)));

    await db.drugs.delete(drugKey);
    await db.drugs.delete(Number(id));

    if (navigator.onLine) {
      try {
        await supabase.from('drugs').delete().eq('id', drugKey);
      } catch (err) {
        console.warn('Cloud permanent delete postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'drug_permanently_deleted',
      targetType: 'drug',
      targetId: drugKey,
      details: { name: existing?.name || 'unknown' }
    });
  } catch (err) {
    console.warn('Unable to permanently delete drug:', err.message);
  }
}

// ============================================================
// DRUG CREATE / EDIT / DELETE from the Drugs & Suppliers hub
// (cashier-needs-approval, same shape as suppliers above)
// ------------------------------------------------------------
// Creating a drug is unrestricted for cashier or manager alike (same as
// suppliers, and same as the existing "add drug not in catalog" path
// inside a restock entry). Editing or deleting one is where the two
// roles diverge: a manager/administrator's change applies immediately;
// a cashier's is recorded in `drugChangeRequests` as PENDING and does
// nothing to the drug until a manager approves it. Deletion either way
// reuses the existing soft-delete (softDeleteDrug) — it only disappears
// from pickers, and an administrator still has to restore or
// permanently delete it from Admin → Recently Deleted.
// ============================================================

export async function requestDrugEdit(drug, changes, actor) {
  try {
    const role = actor?.role;
    const isManager = role === 'manager' || role === 'administrator';

    if (isManager) {
      await db.drugs.update(drug.id, { ...changes, synced: 0 });

      const cloudPayload = {
        name: changes.name,
        unit_type: changes.unitType,
        cost_price: changes.costPrice,
        retail_price: changes.retailPrice,
        wholesale_price: changes.wholesalePrice,
        stock: changes.stock,
        barcode: changes.barcode,
        half_pack_qty: changes.halfPackQty ?? null,
        half_pack_price: changes.halfPackPrice ?? null,
        pack_qty: changes.packQty ?? null,
        pack_price: changes.packPrice ?? null,
        min_stock_qty: changes.minStockQty ?? null,
        recommended_purchase_qty: changes.recommendedPurchaseQty ?? null,
        ...(changes.counterSpace !== undefined ? { counter_space: changes.counterSpace } : {})
      };

      if (navigator.onLine) {
        try {
          const { error } = await supabase
            .from('drugs')
            .update(cloudPayload)
            .eq('id', drug.id);
          if (!error) await db.drugs.update(drug.id, { synced: 1 });
        } catch (err) {
          console.warn('Cloud drug edit postponed:', err.message);
        }
      }

      await recordDrugPriceChoice(
        drug.id,
        changes.costPrice,
        changes.retailPrice,
        changes.wholesalePrice
      );

      await logAuditEvent({
        actorEmail: actor?.email,
        actorRole: actor?.role,
        action: 'drug_updated',
        targetType: 'drug',
        targetId: drug.id,
        details: { name: changes.name }
      });

      return { success: true, applied: true };
    }

    // Cashier — queue it instead of touching the drug directly.
    const request = {
      id: generateId('DRUGCHG'),
      drugId: drug.id,
      type: 'EDIT',
      proposedChanges: changes,
      status: 'PENDING',
      requestedById: actor?.id || null,
      requestedByEmail: actor?.email || 'unknown',
      requestedByRole: role || 'unknown',
      createdAt: new Date().toISOString(),
      decidedByEmail: null,
      decidedAt: null,
      rejectionReason: null,
      synced: 0
    };

    await db.drugChangeRequests.add(request);

    if (navigator.onLine) {
      try {
        const { error } = await supabase.from('drug_change_requests').insert([
          {
            id: request.id,
            drug_id: request.drugId,
            type: request.type,
            proposed_changes: request.proposedChanges,
            status: request.status,
            requested_by: request.requestedById,
            requested_by_email: request.requestedByEmail,
            requested_by_role: request.requestedByRole,
            created_at: request.createdAt,
            decided_by_email: request.decidedByEmail,
            decided_at: request.decidedAt,
            rejection_reason: request.rejectionReason
          }
        ]);
        if (!error) await db.drugChangeRequests.update(request.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud drug edit request postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'drug_edit_requested',
      targetType: 'drug',
      targetId: drug.id,
      details: { proposedName: changes.name }
    });

    return { success: true, applied: false, pending: true };
  } catch (err) {
    console.warn('Unable to request drug edit:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function requestDeleteDrug(drug, actor) {
  const role = actor?.role;
  const isManager = role === 'manager' || role === 'administrator';

  if (isManager) {
    await softDeleteDrug(drug.id, actor);
    return { success: true, applied: true };
  }

  try {
    const request = {
      id: generateId('DRUGCHG'),
      drugId: drug.id,
      type: 'DELETE',
      proposedChanges: null,
      status: 'PENDING',
      requestedById: actor?.id || null,
      requestedByEmail: actor?.email || 'unknown',
      requestedByRole: role || 'unknown',
      createdAt: new Date().toISOString(),
      decidedByEmail: null,
      decidedAt: null,
      rejectionReason: null,
      synced: 0
    };

    await db.drugChangeRequests.add(request);

    if (navigator.onLine) {
      try {
        const { error } = await supabase.from('drug_change_requests').insert([
          {
            id: request.id,
            drug_id: request.drugId,
            type: request.type,
            proposed_changes: request.proposedChanges,
            status: request.status,
            requested_by: request.requestedById,
            requested_by_email: request.requestedByEmail,
            requested_by_role: request.requestedByRole,
            created_at: request.createdAt,
            decided_by_email: request.decidedByEmail,
            decided_at: request.decidedAt,
            rejection_reason: request.rejectionReason
          }
        ]);
        if (!error) await db.drugChangeRequests.update(request.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud drug delete request postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'drug_delete_requested',
      targetType: 'drug',
      targetId: drug.id,
      details: { name: drug.name }
    });

    return { success: true, applied: false, pending: true };
  } catch (err) {
    console.warn('Unable to request drug deletion:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function approveDrugChangeRequest(request, actor) {
  try {
    const freshLocal = await db.drugChangeRequests.get(request.id);
    if (freshLocal && freshLocal.status !== 'PENDING') {
      return { success: false, reason: 'This request has already been handled.' };
    }
    const target = freshLocal || request;

    if (target.type === 'EDIT') {
      await db.drugs.update(target.drugId, { ...target.proposedChanges, synced: 0 });

      if (navigator.onLine) {
        try {
          const c = target.proposedChanges;
          const { error } = await supabase
            .from('drugs')
            .update({
              name: c.name,
              unit_type: c.unitType,
              cost_price: c.costPrice,
              retail_price: c.retailPrice,
              wholesale_price: c.wholesalePrice,
              stock: c.stock,
              barcode: c.barcode,
              half_pack_qty: c.halfPackQty ?? null,
              half_pack_price: c.halfPackPrice ?? null,
              pack_qty: c.packQty ?? null,
              pack_price: c.packPrice ?? null,
              min_stock_qty: c.minStockQty ?? null,
              recommended_purchase_qty: c.recommendedPurchaseQty ?? null,
              ...(c.counterSpace !== undefined ? { counter_space: c.counterSpace } : {})
            })
            .eq('id', target.drugId);
          if (!error) await db.drugs.update(target.drugId, { synced: 1 });
        } catch (err) {
          console.warn('Cloud drug edit (approved) postponed:', err.message);
        }
      }

      await recordDrugPriceChoice(
        target.drugId,
        target.proposedChanges.costPrice,
        target.proposedChanges.retailPrice,
        target.proposedChanges.wholesalePrice
      );
    } else {
      await softDeleteDrug(target.drugId, actor);
    }

    const decidedAt = new Date().toISOString();
    await db.drugChangeRequests.update(target.id, {
      status: 'APPROVED',
      decidedByEmail: actor?.email || 'unknown',
      decidedAt,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('drug_change_requests')
          .update({
            status: 'APPROVED',
            decided_by_email: actor?.email || 'unknown',
            decided_at: decidedAt
          })
          .eq('id', target.id);
        if (!error) await db.drugChangeRequests.update(target.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud drug change approval postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'drug_change_approved',
      targetType: 'drug',
      targetId: target.drugId,
      details: { type: target.type }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to approve drug change:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function rejectDrugChangeRequest(request, reason, actor) {
  try {
    const decidedAt = new Date().toISOString();
    const trimmedReason = (reason || '').trim();

    await db.drugChangeRequests.update(request.id, {
      status: 'REJECTED',
      rejectionReason: trimmedReason,
      decidedByEmail: actor?.email || 'unknown',
      decidedAt,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('drug_change_requests')
          .update({
            status: 'REJECTED',
            rejection_reason: trimmedReason,
            decided_by_email: actor?.email || 'unknown',
            decided_at: decidedAt
          })
          .eq('id', request.id);
        if (!error) await db.drugChangeRequests.update(request.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud drug change rejection postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'drug_change_rejected',
      targetType: 'drug',
      targetId: request.drugId,
      details: { reason: trimmedReason }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to reject drug change:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function fetchCloudDrugChangeRequests() {
  try {
    const { data, error } = await supabase
      .from('drug_change_requests')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!data || data.length === 0) return;

    const pendingIds = new Set(
      (await db.drugChangeRequests.where('synced').equals(0).toArray()).map((r) =>
        String(r.id)
      )
    );

    const mapped = data
      .filter((r) => !pendingIds.has(String(r.id)))
      .map((r) => ({
        id: String(r.id),
        drugId: r.drug_id,
        type: r.type,
        proposedChanges: r.proposed_changes || null,
        status: r.status,
        requestedById: r.requested_by || null,
        requestedByEmail: r.requested_by_email || 'unknown',
        requestedByRole: r.requested_by_role || 'unknown',
        createdAt: r.created_at,
        decidedByEmail: r.decided_by_email || null,
        decidedAt: r.decided_at || null,
        rejectionReason: r.rejection_reason || null,
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.drugChangeRequests.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch drug change requests:', err.message);
  }
}

export async function syncPendingDrugChangeRequestsToCloud() {
  try {
    const pending = await db.drugChangeRequests.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const request of pending) {
      const { error } = await supabase.from('drug_change_requests').upsert([
        {
          id: request.id,
          drug_id: request.drugId,
          type: request.type,
          proposed_changes: request.proposedChanges,
          status: request.status,
          requested_by: request.requestedById,
          requested_by_email: request.requestedByEmail,
          requested_by_role: request.requestedByRole,
          created_at: request.createdAt,
          decided_by_email: request.decidedByEmail,
          decided_at: request.decidedAt,
          rejection_reason: request.rejectionReason
        }
      ]);
      if (!error) await db.drugChangeRequests.update(request.id, { synced: 1 });
    }
  } catch (err) {
    console.warn('Unable to sync pending drug change requests:', err.message);
  }
}

// ============================================================
// BULK SALES-HISTORY DELETION (administrator feature)
// This is a hard delete — sales records are not soft-deletable.
// Double-check this is actually what you want before wiring up
// the confirm dialog, since it's irreversible.
// ============================================================
export async function bulkDeleteSalesByDateRange(startISO, endISO, actor) {
  try {
    const toDelete = await db.sales
      .where('createdAt')
      .between(startISO, endISO, true, true)
      .toArray();

    const ids = toDelete.map((s) => s.id);

    if (ids.length > 0) {
      await db.sales.bulkDelete(ids);
    }

    if (navigator.onLine) {
      try {
        await supabase
          .from('sales')
          .delete()
          .gte('created_at', startISO)
          .lte('created_at', endISO);
      } catch (err) {
        console.warn('Cloud bulk sales delete postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'sales_bulk_deleted',
      targetType: 'sales_range',
      targetId: `${startISO}_to_${endISO}`,
      details: { count: ids.length, startISO, endISO }
    });

    return ids.length;
  } catch (err) {
    console.warn('Unable to bulk-delete sales:', err.message);
    return 0;
  }
}

// ============================================================
// PARTIAL SALE REVERSAL (manager feature)
// Reverses one or more LINE ITEMS from a sale — not the whole sale.
// `reversals` is [{ id: <item id>, quantity: <how many units to
// reverse> }]. Each matching item gets a running `reversedQty` so a
// line can be reversed more than once (e.g. 2 of 5 today, 1 more
// later) without ever reversing more than it originally sold. Stock
// for the affected drugs is restored, the sale's stored total is
// reduced by the refunded amount, and the sale record keeps a
// `reversalLog` of who reversed what and when, for the audit trail.
// ============================================================
export async function reverseSaleItems(sale, reversals, actor) {
  try {
    const saleId = String(sale.id);
    const reversalMap = new Map(
      reversals.map((r) => [String(r.id), Number(r.quantity) || 0])
    );

    let refundTotal = 0;
    const reversedDetails = [];

    const updatedItems = (sale.items || []).map((item) => {
      const reverseQty = reversalMap.get(String(item.id));
      if (!reverseQty || reverseQty <= 0) return item;

      const alreadyReversed = Number(item.reversedQty) || 0;
      const remaining = item.quantity - alreadyReversed;
      const qtyToReverse = Math.min(reverseQty, remaining);
      if (qtyToReverse <= 0) return item;

      // Refund at this item's average per-unit price (its stored
      // lineTotal already reflects any pack discount), so a reversed
      // unit is credited back at what it was actually sold for.
      const perUnitPrice =
        item.quantity > 0
          ? (item.lineTotal ?? item.activePrice * item.quantity) /
            item.quantity
          : item.activePrice || 0;

      const refund = perUnitPrice * qtyToReverse;
      refundTotal += refund;

      reversedDetails.push({
        itemId: item.id,
        name: item.name,
        quantity: qtyToReverse,
        refund,
        reversedBy: actor?.email || 'unknown',
        reversedAt: new Date().toISOString()
      });

      return {
        ...item,
        reversedQty: alreadyReversed + qtyToReverse
      };
    });

    if (reversedDetails.length === 0) {
      return { success: false, reason: 'Nothing to reverse.' };
    }

    const newTotal = Math.max(0, (sale.total || 0) - refundTotal);
    const existingLog = Array.isArray(sale.reversalLog)
      ? sale.reversalLog
      : [];
    const newReversalLog = [...existingLog, ...reversedDetails];

    // Restore stock for each reversed item, locally first.
    for (const detail of reversedDetails) {
      const drugKey = String(detail.itemId);
      const existingDrug =
        (await db.drugs.get(drugKey)) ||
        (await db.drugs.get(Number(detail.itemId)));

      if (existingDrug) {
        const restoredStock =
          (existingDrug.stock || 0) + detail.quantity;

        await db.drugs.update(existingDrug.id, {
          stock: restoredStock,
          synced: 0
        });

        if (navigator.onLine) {
          try {
            // Server-side +quantity, so a sale made on another terminal
            // a moment ago isn't wiped out by this restore.
            const result = await applyCloudStockDelta(
              drugKey,
              detail.quantity,
              restoredStock
            );
            if (result.ok) {
              await db.drugs.update(existingDrug.id, {
                stock: result.stock,
                synced: 1
              });
            }
          } catch (err) {
            console.warn('Cloud stock restore postponed:', err.message);
          }
        }
      }
    }

    // WHOLESALE BALANCE: goods that come back reduce what the customer
    // owes by their refund value. If they'd already paid in full (or the
    // refund is bigger than what they owed) the balance goes NEGATIVE,
    // meaning the pharmacy now owes THEM — it shows as credit on their
    // record and is automatically used up by their next purchase.
    let customerBalanceAdjustment = 0;
    let customerBalanceNow = null;
    if (sale.customerId && sale.saleType === 'wholesale' && refundTotal > 0) {
      customerBalanceAdjustment = refundTotal;
      try {
        const customer = await db.customers.get(sale.customerId);
        if (customer) {
          const localAfter = Number(customer.balance || 0) - refundTotal;
          customerBalanceNow = localAfter;
          await db.customers.update(sale.customerId, {
            balance: localAfter,
            balanceDirty: 1,
            synced: 0
          });
          if (navigator.onLine) {
            const result = await applyCloudCustomerBalanceDelta(
              sale.customerId,
              -refundTotal,
              localAfter
            );
            if (result.ok) {
              customerBalanceNow = result.balance;
              await db.customers.update(sale.customerId, {
                balance: result.balance,
                balanceDirty: 0,
                synced: 1
              });
            }
          }
        }
      } catch (err) {
        console.warn('Customer balance adjustment postponed:', err.message);
      }
      // Tag the log entries so the receipt/history can explain it.
      reversedDetails.forEach((d) => {
        d.balanceCredit = d.refund;
      });
    }

    // Persist the reversed sale locally FIRST, unconditionally — not
    // only when this device already had a local copy. Sales History
    // mostly renders from cloudSales (fetched from Supabase), and the
    // merge logic prefers the local copy over the cloud one, so writing
    // locally with `put` (which both creates and updates) is what makes
    // the reversal survive a reload on this device even if the cloud
    // push below fails or is still offline. `reversalPending: 1` marks
    // it for the retry function below.
    await db.sales.put({
      ...sale,
      items: updatedItems,
      total: newTotal,
      reversalLog: newReversalLog,
      reversalPending: 1
    });

    let cloudSynced = false;

    if (navigator.onLine) {
      try {
        const { error: cloudError } = await supabase
          .from('sales')
          .update({
            items: updatedItems,
            total: newTotal,
            reversal_log: newReversalLog
          })
          .eq('id', saleId);

        if (cloudError) throw cloudError;

        cloudSynced = true;
        await db.sales.update(saleId, { reversalPending: 0 });
      } catch (err) {
        console.warn('Cloud sale reversal postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'sale_items_reversed',
      targetType: 'sale',
      targetId: saleId,
      details: { items: reversedDetails, refundTotal }
    });

    return {
      success: true,
      updatedItems,
      newTotal,
      reversalLog: newReversalLog,
      cloudSynced,
      customerBalanceAdjustment,
      customerBalanceNow
    };
  } catch (err) {
    console.warn('Unable to reverse sale items:', err.message);
    return { success: false, reason: err.message };
  }
}

// Mirrors syncPendingDrugsToCloud()/syncPendingSalesToCloud(): retries
// pushing a reversal's updated items/total up to Supabase for any sale
// where the cloud push failed or was offline at the time (reversalPending).
export async function syncPendingReversalsToCloud() {
  try {
    const pending = await db.sales
      .where('reversalPending')
      .equals(1)
      .toArray();

    if (pending.length === 0) return;

    for (const sale of pending) {
      const { error } = await supabase
        .from('sales')
        .update({
          items: sale.items,
          total: sale.total,
          reversal_log: sale.reversalLog
        })
        .eq('id', sale.id);

      if (!error) {
        await db.sales.update(sale.id, { reversalPending: 0 });
      }
    }
  } catch (err) {
    console.warn('Unable to sync pending reversals:', err.message);
  }
}

// ============================================================
// REVERSAL REQUESTS (cashier-initiated reversal, needs manager sign-off)
// ------------------------------------------------------------
// A manager/administrator reversing a sale still happens immediately via
// reverseSaleItems() above. A CASHIER reversing something instead creates
// a request here — nothing about the sale changes (no stock restored, no
// total reduced) until a manager or administrator approves it. Separation
// of duties: the person who confirmed the refund to a customer isn't the
// same person who authorizes it.
// ============================================================

export async function requestSaleReversal(sale, reversals, actor) {
  const request = {
    id: generateId('RREQ'),
    saleId: String(sale.id),
    saleSnapshot: {
      id: sale.id,
      customerName: sale.customerName,
      total: sale.total,
      items: sale.items
    },
    reversals,
    status: 'PENDING',
    requestedBy: actor?.id || null,
    requestedByEmail: actor?.email || 'unknown',
    createdAt: new Date().toISOString(),
    decidedBy: null,
    decidedByEmail: null,
    decidedAt: null,
    synced: 0
  };

  try {
    await db.reversalRequests.add(request);
  } catch (err) {
    console.warn('Unable to write reversal request locally:', err.message);
    return { success: false, reason: err.message };
  }

  if (navigator.onLine) {
    try {
      const { error } = await supabase.from('reversal_requests').insert([
        {
          id: request.id,
          sale_id: request.saleId,
          sale_snapshot: request.saleSnapshot,
          reversals: request.reversals,
          status: request.status,
          requested_by: request.requestedBy,
          requested_by_email: request.requestedByEmail,
          created_at: request.createdAt
        }
      ]);
      if (!error) await db.reversalRequests.update(request.id, { synced: 1 });
    } catch (err) {
      console.warn('Cloud reversal request creation postponed:', err.message);
    }
  }

  await logAuditEvent({
    actorEmail: actor?.email,
    actorRole: actor?.role,
    action: 'reversal_requested',
    targetType: 'sale',
    targetId: request.saleId,
    details: { requestId: request.id, reversals }
  });

  return { success: true, request };
}

export async function fetchCloudReversalRequests() {
  try {
    const { data, error } = await supabase
      .from('reversal_requests')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!data || data.length === 0) return;

    const pendingIds = new Set(
      (await db.reversalRequests.where('synced').equals(0).toArray()).map((r) =>
        String(r.id)
      )
    );

    const mapped = data
      .filter((r) => !pendingIds.has(String(r.id)))
      .map((r) => ({
        id: String(r.id),
        saleId: String(r.sale_id),
        saleSnapshot: r.sale_snapshot || null,
        reversals: r.reversals || [],
        status: r.status,
        requestedBy: r.requested_by || null,
        requestedByEmail: r.requested_by_email || 'unknown',
        createdAt: r.created_at,
        decidedBy: r.decided_by || null,
        decidedByEmail: r.decided_by_email || null,
        decidedAt: r.decided_at || null,
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.reversalRequests.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch reversal requests from cloud:', err.message);
  }
}

export async function syncPendingReversalRequestsToCloud() {
  try {
    const pending = await db.reversalRequests.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const request of pending) {
      const { error } = await supabase.from('reversal_requests').upsert([
        {
          id: request.id,
          sale_id: request.saleId,
          sale_snapshot: request.saleSnapshot,
          reversals: request.reversals,
          status: request.status,
          requested_by: request.requestedBy,
          requested_by_email: request.requestedByEmail,
          created_at: request.createdAt,
          decided_by: request.decidedBy,
          decided_by_email: request.decidedByEmail,
          decided_at: request.decidedAt
        }
      ]);
      if (!error) await db.reversalRequests.update(request.id, { synced: 1 });
    }
  } catch (err) {
    console.warn('Unable to sync pending reversal requests:', err.message);
  }
}

// Approving a request is what actually calls reverseSaleItems() — the
// request just gated WHEN that happens. `sale` must be the current full
// sale record (caller looks it up by request.saleId).
export async function approveReversalRequest(request, sale, actor) {
  try {
    const freshLocal = await db.reversalRequests.get(request.id);
    if (freshLocal && freshLocal.status !== 'PENDING') {
      return { success: false, reason: 'This request has already been handled.' };
    }

    const result = await reverseSaleItems(sale, request.reversals, actor);
    if (!result.success) return result;

    const decidedAt = new Date().toISOString();

    await db.reversalRequests.update(request.id, {
      status: 'APPROVED',
      decidedBy: actor?.id || null,
      decidedByEmail: actor?.email || 'unknown',
      decidedAt,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('reversal_requests')
          .update({
            status: 'APPROVED',
            decided_by: actor?.id || null,
            decided_by_email: actor?.email || 'unknown',
            decided_at: decidedAt
          })
          .eq('id', request.id);
        if (!error) await db.reversalRequests.update(request.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud reversal request approval postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'reversal_request_approved',
      targetType: 'sale',
      targetId: request.saleId,
      details: { requestId: request.id }
    });

    return { success: true, ...result };
  } catch (err) {
    console.warn('Unable to approve reversal request:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function rejectReversalRequest(request, actor) {
  try {
    const decidedAt = new Date().toISOString();

    await db.reversalRequests.update(request.id, {
      status: 'REJECTED',
      decidedBy: actor?.id || null,
      decidedByEmail: actor?.email || 'unknown',
      decidedAt,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('reversal_requests')
          .update({
            status: 'REJECTED',
            decided_by: actor?.id || null,
            decided_by_email: actor?.email || 'unknown',
            decided_at: decidedAt
          })
          .eq('id', request.id);
        if (!error) await db.reversalRequests.update(request.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud reversal request rejection postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'reversal_request_rejected',
      targetType: 'sale',
      targetId: request.saleId,
      details: { requestId: request.id }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to reject reversal request:', err.message);
    return { success: false, reason: err.message };
  }
}

// ============================================================
// SUPPLIERS & STOCK ENTRIES (restocking workflow)
// ------------------------------------------------------------
// A stock entry is a batch of drugs received from one supplier on one
// occasion — each line either tops up an existing drug's stock (and
// updates its cost price to what this supplier charged) or creates a
// brand-new drug that didn't exist yet. Cashiers and managers can both
// enter stock; a manager's entry applies immediately, a cashier's sits
// as PENDING until a manager approves it (same shape as the reversal-
// request workflow above, deliberately manager-only — not
// administrator — since the person asking for this said "approval from
// managers" and cashiers/managers are the only two roles that touch
// this feature at all).
// ============================================================

export async function fetchSuppliers() {
  try {
    const { data, error } = await supabase.from('suppliers').select('*');
    if (error) throw error;
    if (!data) return;

    const pendingIds = new Set(
      (await db.suppliers.where('synced').equals(0).toArray()).map((s) =>
        String(s.id)
      )
    );

    const mapped = data
      .filter((s) => !pendingIds.has(String(s.id)))
      .map((s) => ({
        id: String(s.id),
        name: s.name,
        contactPerson: s.contact_person || '',
        phone: s.phone || '',
        email: s.email || '',
        address: s.address || '',
        deletedAt: s.deleted_at || null,
        deletedBy: s.deleted_by || null,
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.suppliers.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch suppliers:', err.message);
  }
}

export async function addSupplier(payload, actor) {
  const supplier = {
    id: generateId('SUPPLIER'),
    name: (payload.name || '').trim(),
    contactPerson: (payload.contactPerson || '').trim(),
    phone: (payload.phone || '').trim(),
    email: (payload.email || '').trim(),
    address: (payload.address || '').trim(),
    synced: 0
  };

  await db.suppliers.add(supplier);

  if (navigator.onLine) {
    try {
      const { error } = await supabase.from('suppliers').insert([
        {
          id: supplier.id,
          name: supplier.name,
          contact_person: supplier.contactPerson,
          phone: supplier.phone,
          email: supplier.email,
          address: supplier.address
        }
      ]);
      if (!error) await db.suppliers.update(supplier.id, { synced: 1 });
    } catch (err) {
      console.warn('Cloud supplier create postponed:', err.message);
    }
  }

  await logAuditEvent({
    actorEmail: actor?.email,
    actorRole: actor?.role,
    action: 'supplier_added',
    targetType: 'supplier',
    targetId: supplier.id,
    details: { name: supplier.name }
  });

  return supplier;
}

export async function syncPendingSuppliersToCloud() {
  try {
    const pending = await db.suppliers.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const supplier of pending) {
      const { error } = await supabase.from('suppliers').upsert([
        {
          id: supplier.id,
          name: supplier.name,
          contact_person: supplier.contactPerson,
          phone: supplier.phone,
          email: supplier.email,
          address: supplier.address,
          deleted_at: supplier.deletedAt || null,
          deleted_by: supplier.deletedBy || null
        }
      ]);
      if (!error) await db.suppliers.update(supplier.id, { synced: 1 });
    }
  } catch (err) {
    console.warn('Unable to sync pending suppliers:', err.message);
  }
}

// ============================================================
// SUPPLIER EDIT / DELETE (cashier-needs-approval, same shape used
// everywhere else in this file)
// ------------------------------------------------------------
// A manager/administrator's edit or delete on a supplier applies
// immediately. A cashier's edit or delete is recorded in
// `supplierChangeRequests` as PENDING and does nothing to the supplier
// record until a manager approves it. Deletion either way is a SOFT
// delete (deletedAt/deletedBy set, same as a drug) — it only disappears
// from pickers, it isn't gone. An administrator still has to restore or
// permanently delete it from Admin → Recently Deleted, same as a drug;
// a manager approving a cashier's delete request only gets it to that
// same soft-deleted/awaiting-admin state, never further.
// ============================================================

export async function updateSupplier(supplier, changes, actor) {
  try {
    const role = actor?.role;
    const isManager = role === 'manager' || role === 'administrator';

    const cleaned = {
      name: (changes.name ?? supplier.name ?? '').trim(),
      contactPerson: (changes.contactPerson ?? supplier.contactPerson ?? '').trim(),
      phone: (changes.phone ?? supplier.phone ?? '').trim(),
      email: (changes.email ?? supplier.email ?? '').trim(),
      address: (changes.address ?? supplier.address ?? '').trim()
    };

    if (isManager) {
      await db.suppliers.update(supplier.id, { ...cleaned, synced: 0 });

      if (navigator.onLine) {
        try {
          const { error } = await supabase
            .from('suppliers')
            .update({
              name: cleaned.name,
              contact_person: cleaned.contactPerson,
              phone: cleaned.phone,
              email: cleaned.email,
              address: cleaned.address
            })
            .eq('id', supplier.id);
          if (!error) await db.suppliers.update(supplier.id, { synced: 1 });
        } catch (err) {
          console.warn('Cloud supplier update postponed:', err.message);
        }
      }

      await logAuditEvent({
        actorEmail: actor?.email,
        actorRole: actor?.role,
        action: 'supplier_updated',
        targetType: 'supplier',
        targetId: supplier.id,
        details: { name: cleaned.name }
      });

      return { success: true, applied: true };
    }

    // Cashier — queue it instead of touching the supplier directly.
    const request = {
      id: generateId('SUPCHG'),
      supplierId: supplier.id,
      type: 'EDIT',
      proposedChanges: cleaned,
      status: 'PENDING',
      requestedById: actor?.id || null,
      requestedByEmail: actor?.email || 'unknown',
      requestedByRole: role || 'unknown',
      createdAt: new Date().toISOString(),
      decidedByEmail: null,
      decidedAt: null,
      rejectionReason: null,
      synced: 0
    };

    await db.supplierChangeRequests.add(request);

    if (navigator.onLine) {
      try {
        const { error } = await supabase.from('supplier_change_requests').insert([
          {
            id: request.id,
            supplier_id: request.supplierId,
            type: request.type,
            proposed_changes: request.proposedChanges,
            status: request.status,
            requested_by: request.requestedById,
            requested_by_email: request.requestedByEmail,
            requested_by_role: request.requestedByRole,
            created_at: request.createdAt,
            decided_by_email: request.decidedByEmail,
            decided_at: request.decidedAt,
            rejection_reason: request.rejectionReason
          }
        ]);
        if (!error) await db.supplierChangeRequests.update(request.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud supplier edit request postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'supplier_edit_requested',
      targetType: 'supplier',
      targetId: supplier.id,
      details: { proposedName: cleaned.name }
    });

    return { success: true, applied: false, pending: true };
  } catch (err) {
    console.warn('Unable to update supplier:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function softDeleteSupplier(id, actor) {
  try {
    const existing = await db.suppliers.get(id);
    if (!existing) return { success: false, reason: 'Supplier not found.' };

    const deletedAt = new Date().toISOString();
    const deletedBy = actor?.email || 'unknown';

    await db.suppliers.update(id, { deletedAt, deletedBy, synced: 0 });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('suppliers')
          .update({ deleted_at: deletedAt, deleted_by: deletedBy })
          .eq('id', id);
        if (!error) await db.suppliers.update(id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud supplier soft-delete postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'supplier_deleted',
      targetType: 'supplier',
      targetId: id,
      details: { name: existing.name }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to delete supplier:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function requestDeleteSupplier(supplier, actor) {
  const role = actor?.role;
  const isManager = role === 'manager' || role === 'administrator';

  if (isManager) {
    // Still only a SOFT delete, same as a manager deleting a drug — an
    // administrator finalizes it (or restores it) from Recently Deleted.
    return softDeleteSupplier(supplier.id, actor);
  }

  try {
    const request = {
      id: generateId('SUPCHG'),
      supplierId: supplier.id,
      type: 'DELETE',
      proposedChanges: null,
      status: 'PENDING',
      requestedById: actor?.id || null,
      requestedByEmail: actor?.email || 'unknown',
      requestedByRole: role || 'unknown',
      createdAt: new Date().toISOString(),
      decidedByEmail: null,
      decidedAt: null,
      rejectionReason: null,
      synced: 0
    };

    await db.supplierChangeRequests.add(request);

    if (navigator.onLine) {
      try {
        const { error } = await supabase.from('supplier_change_requests').insert([
          {
            id: request.id,
            supplier_id: request.supplierId,
            type: request.type,
            proposed_changes: request.proposedChanges,
            status: request.status,
            requested_by: request.requestedById,
            requested_by_email: request.requestedByEmail,
            requested_by_role: request.requestedByRole,
            created_at: request.createdAt,
            decided_by_email: request.decidedByEmail,
            decided_at: request.decidedAt,
            rejection_reason: request.rejectionReason
          }
        ]);
        if (!error) await db.supplierChangeRequests.update(request.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud supplier delete request postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'supplier_delete_requested',
      targetType: 'supplier',
      targetId: supplier.id,
      details: { name: supplier.name }
    });

    return { success: true, applied: false, pending: true };
  } catch (err) {
    console.warn('Unable to request supplier deletion:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function restoreSupplier(id, actor) {
  try {
    const existing = await db.suppliers.get(id);
    if (!existing) return;

    await db.suppliers.update(id, { deletedAt: null, deletedBy: null, synced: 0 });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('suppliers')
          .update({ deleted_at: null, deleted_by: null })
          .eq('id', id);
        if (!error) await db.suppliers.update(id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud supplier restore postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'supplier_restored',
      targetType: 'supplier',
      targetId: id,
      details: { name: existing.name }
    });
  } catch (err) {
    console.warn('Unable to restore supplier:', err.message);
  }
}

export async function permanentlyDeleteSupplier(id, actor) {
  try {
    const existing = await db.suppliers.get(id);

    await db.suppliers.delete(id);

    if (navigator.onLine) {
      try {
        await supabase.from('suppliers').delete().eq('id', id);
      } catch (err) {
        console.warn('Cloud supplier permanent delete postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'supplier_permanently_deleted',
      targetType: 'supplier',
      targetId: id,
      details: { name: existing?.name || 'unknown' }
    });
  } catch (err) {
    console.warn('Unable to permanently delete supplier:', err.message);
  }
}

export async function approveSupplierChangeRequest(request, actor) {
  try {
    const freshLocal = await db.supplierChangeRequests.get(request.id);
    if (freshLocal && freshLocal.status !== 'PENDING') {
      return { success: false, reason: 'This request has already been handled.' };
    }
    const target = freshLocal || request;

    if (target.type === 'EDIT') {
      await db.suppliers.update(target.supplierId, {
        ...target.proposedChanges,
        synced: 0
      });

      if (navigator.onLine) {
        try {
          const { error } = await supabase
            .from('suppliers')
            .update({
              name: target.proposedChanges.name,
              contact_person: target.proposedChanges.contactPerson,
              phone: target.proposedChanges.phone,
              email: target.proposedChanges.email,
              address: target.proposedChanges.address
            })
            .eq('id', target.supplierId);
          if (!error) await db.suppliers.update(target.supplierId, { synced: 1 });
        } catch (err) {
          console.warn('Cloud supplier edit (approved) postponed:', err.message);
        }
      }
    } else {
      await softDeleteSupplier(target.supplierId, actor);
    }

    const decidedAt = new Date().toISOString();
    await db.supplierChangeRequests.update(target.id, {
      status: 'APPROVED',
      decidedByEmail: actor?.email || 'unknown',
      decidedAt,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('supplier_change_requests')
          .update({
            status: 'APPROVED',
            decided_by_email: actor?.email || 'unknown',
            decided_at: decidedAt
          })
          .eq('id', target.id);
        if (!error) await db.supplierChangeRequests.update(target.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud supplier change approval postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'supplier_change_approved',
      targetType: 'supplier',
      targetId: target.supplierId,
      details: { type: target.type }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to approve supplier change:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function rejectSupplierChangeRequest(request, reason, actor) {
  try {
    const decidedAt = new Date().toISOString();
    const trimmedReason = (reason || '').trim();

    await db.supplierChangeRequests.update(request.id, {
      status: 'REJECTED',
      rejectionReason: trimmedReason,
      decidedByEmail: actor?.email || 'unknown',
      decidedAt,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('supplier_change_requests')
          .update({
            status: 'REJECTED',
            rejection_reason: trimmedReason,
            decided_by_email: actor?.email || 'unknown',
            decided_at: decidedAt
          })
          .eq('id', request.id);
        if (!error) await db.supplierChangeRequests.update(request.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud supplier change rejection postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'supplier_change_rejected',
      targetType: 'supplier',
      targetId: request.supplierId,
      details: { reason: trimmedReason }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to reject supplier change:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function fetchCloudSupplierChangeRequests() {
  try {
    const { data, error } = await supabase
      .from('supplier_change_requests')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!data || data.length === 0) return;

    const pendingIds = new Set(
      (await db.supplierChangeRequests.where('synced').equals(0).toArray()).map((r) =>
        String(r.id)
      )
    );

    const mapped = data
      .filter((r) => !pendingIds.has(String(r.id)))
      .map((r) => ({
        id: String(r.id),
        supplierId: r.supplier_id,
        type: r.type,
        proposedChanges: r.proposed_changes || null,
        status: r.status,
        requestedById: r.requested_by || null,
        requestedByEmail: r.requested_by_email || 'unknown',
        requestedByRole: r.requested_by_role || 'unknown',
        createdAt: r.created_at,
        decidedByEmail: r.decided_by_email || null,
        decidedAt: r.decided_at || null,
        rejectionReason: r.rejection_reason || null,
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.supplierChangeRequests.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch supplier change requests:', err.message);
  }
}

export async function syncPendingSupplierChangeRequestsToCloud() {
  try {
    const pending = await db.supplierChangeRequests.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const request of pending) {
      const { error } = await supabase.from('supplier_change_requests').upsert([
        {
          id: request.id,
          supplier_id: request.supplierId,
          type: request.type,
          proposed_changes: request.proposedChanges,
          status: request.status,
          requested_by: request.requestedById,
          requested_by_email: request.requestedByEmail,
          requested_by_role: request.requestedByRole,
          created_at: request.createdAt,
          decided_by_email: request.decidedByEmail,
          decided_at: request.decidedAt,
          rejection_reason: request.rejectionReason
        }
      ]);
      if (!error) await db.supplierChangeRequests.update(request.id, { synced: 1 });
    }
  } catch (err) {
    console.warn('Unable to sync pending supplier change requests:', err.message);
  }
}

// ============================================================
// WHOLESALE CUSTOMERS — a real record (not just free-text name/phone
// on a ticket), CRUD'd the exact same cashier-needs-approval way as
// suppliers and drugs above: a manager/administrator's edit or delete
// applies immediately, a cashier's is queued in `customerChangeRequests`
// until a manager approves it. Deletion is a SOFT delete, same pattern —
// an administrator still has to restore or permanently delete it from
// Recently Deleted.
//
// `balance` is deliberately NOT part of this CRUD surface — it only
// ever changes through the payment flow in recordWholesalePayment()
// below, never through an edit form. Positive = the customer owes the
// pharmacy; negative = the pharmacy owes the customer (an overpayment).
// ============================================================

export async function fetchCustomers() {
  try {
    const { data, error } = await supabase.from('customers').select('*');
    if (error) throw error;
    if (!data) return;

    const pendingIds = new Set(
      (await db.customers.where('synced').equals(0).toArray()).map((c) =>
        String(c.id)
      )
    );

    const mapped = data
      .filter((c) => !pendingIds.has(String(c.id)))
      .map((c) => {
        const phones = Array.isArray(c.phones) && c.phones.length > 0
          ? c.phones
          : (c.phone ? [c.phone] : []);
        return {
          id: String(c.id),
          name: c.name,
          phones,
          phone: phones[0] || '',
          email: c.email || '',
          address: c.address || '',
          balance: Number(c.balance || 0),
          deletedAt: c.deleted_at || null,
          deletedBy: c.deleted_by || null,
          synced: 1
        };
      });

    if (mapped.length > 0) {
      await db.customers.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch customers:', err.message);
  }
}

// Normalizes whatever shape of phone numbers a form hands over (a
// single `phone` string, or an array of several) into a clean array
// with no blanks, plus a `phone` convenience field holding the first
// one — kept so every existing read site (ticket snapshots, receipts,
// search) that only knows about a single `phone` keeps working.
function normalizeCustomerPhones(payload) {
  const raw = Array.isArray(payload.phones)
    ? payload.phones
    : payload.phone
      ? [payload.phone]
      : [];
  const phones = raw.map((p) => String(p || '').trim()).filter(Boolean);
  return { phones, phone: phones[0] || '' };
}

// A brand-new wholesale customer can't owe anything until a manager
// has approved them (see the PRICE... no, see the WHOLESALE CUSTOMER
// DYNAMIC note at approveTicket below) — so unlike every other field
// on a customer, *creating* one isn't something a cashier can do
// outright. A manager/administrator creates one directly, same as
// always. A cashier instead submits a CREATE request, exactly like an
// EDIT or DELETE request: nothing usable exists yet until a manager
// approves it.
export async function addCustomer(payload, actor) {
  const role = actor?.role;
  const isManager = role === 'manager' || role === 'administrator';
  const { phones, phone } = normalizeCustomerPhones(payload);
  const name = (payload.name || '').trim();
  const email = (payload.email || '').trim();
  const address = (payload.address || '').trim();

  if (isManager) {
    const customer = {
      id: generateId('CUSTOMER'),
      name,
      phones,
      phone,
      email,
      address,
      balance: 0,
      synced: 0
    };

    await db.customers.add(customer);

    if (navigator.onLine) {
      try {
        const { error } = await supabase.from('customers').insert([
          {
            id: customer.id,
            name: customer.name,
            phones: customer.phones,
            phone: customer.phone,
            email: customer.email,
            address: customer.address,
            balance: 0
          }
        ]);
        if (!error) await db.customers.update(customer.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud customer create postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'customer_added',
      targetType: 'customer',
      targetId: customer.id,
      details: { name: customer.name }
    });

    return { success: true, applied: true, customer };
  }

  // Cashier — queue a CREATE request instead. The id is generated now
  // (not on approval) so it's stable from the moment the request is
  // raised, but the row in `customers` itself doesn't exist until a
  // manager approves it.
  try {
    const customerId = generateId('CUSTOMER');
    const request = {
      id: generateId('CUSTCHG'),
      customerId,
      type: 'CREATE',
      proposedChanges: { name, phones, phone, email, address },
      status: 'PENDING',
      requestedById: actor?.id || null,
      requestedByEmail: actor?.email || 'unknown',
      requestedByRole: role || 'unknown',
      createdAt: new Date().toISOString(),
      decidedByEmail: null,
      decidedAt: null,
      rejectionReason: null,
      synced: 0
    };

    await db.customerChangeRequests.add(request);

    if (navigator.onLine) {
      try {
        const { error } = await supabase.from('customer_change_requests').insert([
          {
            id: request.id,
            customer_id: request.customerId,
            type: request.type,
            proposed_changes: request.proposedChanges,
            status: request.status,
            requested_by: request.requestedById,
            requested_by_email: request.requestedByEmail,
            requested_by_role: request.requestedByRole,
            created_at: request.createdAt,
            decided_by_email: request.decidedByEmail,
            decided_at: request.decidedAt,
            rejection_reason: request.rejectionReason
          }
        ]);
        if (!error) await db.customerChangeRequests.update(request.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud customer create request postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'customer_create_requested',
      targetType: 'customer',
      targetId: customerId,
      details: { name }
    });

    return { success: true, applied: false, pending: true, requestId: request.id, customerId };
  } catch (err) {
    console.warn('Unable to request new customer:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function syncPendingCustomersToCloud() {
  try {
    const pending = await db.customers.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const customer of pending) {
      // Only send the balance when this device has an unconfirmed
      // balance change (balanceDirty) or the customer isn't in the cloud
      // yet. A plain name/address edit must never overwrite a balance
      // another terminal has changed since this device last looked.
      let includeBalance = Boolean(customer.balanceDirty);
      if (!includeBalance) {
        const { data: existing } = await supabase
          .from('customers')
          .select('id')
          .eq('id', customer.id)
          .maybeSingle();
        includeBalance = !existing;
      }

      const row = {
        id: customer.id,
        name: customer.name,
        phones: customer.phones || (customer.phone ? [customer.phone] : []),
        phone: customer.phone,
        email: customer.email,
        address: customer.address,
        deleted_at: customer.deletedAt || null,
        deleted_by: customer.deletedBy || null
      };
      if (includeBalance) row.balance = customer.balance;

      const { error } = await supabase.from('customers').upsert([row]);
      if (!error) {
        await db.customers.update(customer.id, { synced: 1, balanceDirty: 0 });
      }
    }
  } catch (err) {
    console.warn('Unable to sync pending customers:', err.message);
  }
}

export async function updateCustomer(customer, changes, actor) {
  try {
    const role = actor?.role;
    const isManager = role === 'manager' || role === 'administrator';

    const phonesChanged = normalizeCustomerPhones(
      changes.phones !== undefined || changes.phone !== undefined
        ? changes
        : customer
    );

    const cleaned = {
      name: (changes.name ?? customer.name ?? '').trim(),
      phones: phonesChanged.phones,
      phone: phonesChanged.phone,
      email: (changes.email ?? customer.email ?? '').trim(),
      address: (changes.address ?? customer.address ?? '').trim()
    };

    if (isManager) {
      await db.customers.update(customer.id, { ...cleaned, synced: 0 });

      if (navigator.onLine) {
        try {
          const { error } = await supabase
            .from('customers')
            .update({
              name: cleaned.name,
              phones: cleaned.phones,
              phone: cleaned.phone,
              email: cleaned.email,
              address: cleaned.address
            })
            .eq('id', customer.id);
          if (!error) await db.customers.update(customer.id, { synced: 1 });
        } catch (err) {
          console.warn('Cloud customer update postponed:', err.message);
        }
      }

      await logAuditEvent({
        actorEmail: actor?.email,
        actorRole: actor?.role,
        action: 'customer_updated',
        targetType: 'customer',
        targetId: customer.id,
        details: { name: cleaned.name }
      });

      return { success: true, applied: true };
    }

    // Cashier — queue it instead of touching the customer directly.
    const request = {
      id: generateId('CUSTCHG'),
      customerId: customer.id,
      type: 'EDIT',
      proposedChanges: cleaned,
      status: 'PENDING',
      requestedById: actor?.id || null,
      requestedByEmail: actor?.email || 'unknown',
      requestedByRole: role || 'unknown',
      createdAt: new Date().toISOString(),
      decidedByEmail: null,
      decidedAt: null,
      rejectionReason: null,
      synced: 0
    };

    await db.customerChangeRequests.add(request);

    if (navigator.onLine) {
      try {
        const { error } = await supabase.from('customer_change_requests').insert([
          {
            id: request.id,
            customer_id: request.customerId,
            type: request.type,
            proposed_changes: request.proposedChanges,
            status: request.status,
            requested_by: request.requestedById,
            requested_by_email: request.requestedByEmail,
            requested_by_role: request.requestedByRole,
            created_at: request.createdAt,
            decided_by_email: request.decidedByEmail,
            decided_at: request.decidedAt,
            rejection_reason: request.rejectionReason
          }
        ]);
        if (!error) await db.customerChangeRequests.update(request.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud customer edit request postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'customer_edit_requested',
      targetType: 'customer',
      targetId: customer.id,
      details: { proposedName: cleaned.name }
    });

    return { success: true, applied: false, pending: true };
  } catch (err) {
    console.warn('Unable to update customer:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function softDeleteCustomer(id, actor) {
  try {
    const existing = await db.customers.get(id);
    if (!existing) return { success: false, reason: 'Customer not found.' };

    const deletedAt = new Date().toISOString();
    const deletedBy = actor?.email || 'unknown';

    await db.customers.update(id, { deletedAt, deletedBy, synced: 0 });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('customers')
          .update({ deleted_at: deletedAt, deleted_by: deletedBy })
          .eq('id', id);
        if (!error) await db.customers.update(id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud customer soft-delete postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'customer_deleted',
      targetType: 'customer',
      targetId: id,
      details: { name: existing.name }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to delete customer:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function requestDeleteCustomer(customer, actor) {
  const role = actor?.role;
  const isManager = role === 'manager' || role === 'administrator';

  if (isManager) {
    return softDeleteCustomer(customer.id, actor);
  }

  try {
    const request = {
      id: generateId('CUSTCHG'),
      customerId: customer.id,
      type: 'DELETE',
      proposedChanges: null,
      status: 'PENDING',
      requestedById: actor?.id || null,
      requestedByEmail: actor?.email || 'unknown',
      requestedByRole: role || 'unknown',
      createdAt: new Date().toISOString(),
      decidedByEmail: null,
      decidedAt: null,
      rejectionReason: null,
      synced: 0
    };

    await db.customerChangeRequests.add(request);

    if (navigator.onLine) {
      try {
        const { error } = await supabase.from('customer_change_requests').insert([
          {
            id: request.id,
            customer_id: request.customerId,
            type: request.type,
            proposed_changes: request.proposedChanges,
            status: request.status,
            requested_by: request.requestedById,
            requested_by_email: request.requestedByEmail,
            requested_by_role: request.requestedByRole,
            created_at: request.createdAt,
            decided_by_email: request.decidedByEmail,
            decided_at: request.decidedAt,
            rejection_reason: request.rejectionReason
          }
        ]);
        if (!error) await db.customerChangeRequests.update(request.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud customer delete request postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'customer_delete_requested',
      targetType: 'customer',
      targetId: customer.id,
      details: { name: customer.name }
    });

    return { success: true, applied: false, pending: true };
  } catch (err) {
    console.warn('Unable to request customer deletion:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function restoreCustomer(id, actor) {
  try {
    const existing = await db.customers.get(id);
    if (!existing) return;

    await db.customers.update(id, { deletedAt: null, deletedBy: null, synced: 0 });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('customers')
          .update({ deleted_at: null, deleted_by: null })
          .eq('id', id);
        if (!error) await db.customers.update(id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud customer restore postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'customer_restored',
      targetType: 'customer',
      targetId: id,
      details: { name: existing.name }
    });
  } catch (err) {
    console.warn('Unable to restore customer:', err.message);
  }
}

export async function permanentlyDeleteCustomer(id, actor) {
  try {
    const existing = await db.customers.get(id);

    await db.customers.delete(id);

    if (navigator.onLine) {
      try {
        await supabase.from('customers').delete().eq('id', id);
      } catch (err) {
        console.warn('Cloud customer permanent delete postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'customer_permanently_deleted',
      targetType: 'customer',
      targetId: id,
      details: { name: existing?.name || 'unknown' }
    });
  } catch (err) {
    console.warn('Unable to permanently delete customer:', err.message);
  }
}

export async function approveCustomerChangeRequest(request, actor) {
  try {
    const freshLocal = await db.customerChangeRequests.get(request.id);
    if (freshLocal && freshLocal.status !== 'PENDING') {
      return { success: false, reason: 'This request has already been handled.' };
    }
    const target = freshLocal || request;

    if (target.type === 'CREATE') {
      // Nothing exists in `customers` yet for this one — this is the
      // moment it actually gets created, now that a manager has signed
      // off on it. Only from here on can this customer be linked to a
      // ticket and allowed to owe.
      const p = target.proposedChanges || {};
      const customer = {
        id: target.customerId,
        name: p.name || '',
        phones: p.phones || (p.phone ? [p.phone] : []),
        phone: p.phone || (p.phones && p.phones[0]) || '',
        email: p.email || '',
        address: p.address || '',
        balance: 0,
        synced: 0
      };
      await db.customers.add(customer);

      if (navigator.onLine) {
        try {
          const { error } = await supabase.from('customers').insert([
            {
              id: customer.id,
              name: customer.name,
              phones: customer.phones,
              phone: customer.phone,
              email: customer.email,
              address: customer.address,
              balance: 0
            }
          ]);
          if (!error) await db.customers.update(customer.id, { synced: 1 });
        } catch (err) {
          console.warn('Cloud customer create (approved) postponed:', err.message);
        }
      }
    } else if (target.type === 'EDIT') {
      await db.customers.update(target.customerId, {
        ...target.proposedChanges,
        synced: 0
      });

      if (navigator.onLine) {
        try {
          const { error } = await supabase
            .from('customers')
            .update({
              name: target.proposedChanges.name,
              phones: target.proposedChanges.phones || (target.proposedChanges.phone ? [target.proposedChanges.phone] : []),
              phone: target.proposedChanges.phone,
              email: target.proposedChanges.email,
              address: target.proposedChanges.address
            })
            .eq('id', target.customerId);
          if (!error) await db.customers.update(target.customerId, { synced: 1 });
        } catch (err) {
          console.warn('Cloud customer edit (approved) postponed:', err.message);
        }
      }
    } else {
      await softDeleteCustomer(target.customerId, actor);
    }

    const decidedAt = new Date().toISOString();
    await db.customerChangeRequests.update(target.id, {
      status: 'APPROVED',
      decidedByEmail: actor?.email || 'unknown',
      decidedAt,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('customer_change_requests')
          .update({
            status: 'APPROVED',
            decided_by_email: actor?.email || 'unknown',
            decided_at: decidedAt
          })
          .eq('id', target.id);
        if (!error) await db.customerChangeRequests.update(target.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud customer change approval postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'customer_change_approved',
      targetType: 'customer',
      targetId: target.customerId,
      details: { type: target.type }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to approve customer change:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function rejectCustomerChangeRequest(request, reason, actor) {
  try {
    const decidedAt = new Date().toISOString();
    const trimmedReason = (reason || '').trim();

    await db.customerChangeRequests.update(request.id, {
      status: 'REJECTED',
      rejectionReason: trimmedReason,
      decidedByEmail: actor?.email || 'unknown',
      decidedAt,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('customer_change_requests')
          .update({
            status: 'REJECTED',
            rejection_reason: trimmedReason,
            decided_by_email: actor?.email || 'unknown',
            decided_at: decidedAt
          })
          .eq('id', request.id);
        if (!error) await db.customerChangeRequests.update(request.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud customer change rejection postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'customer_change_rejected',
      targetType: 'customer',
      targetId: request.customerId,
      details: { reason: trimmedReason }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to reject customer change:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function fetchCloudCustomerChangeRequests() {
  try {
    const { data, error } = await supabase
      .from('customer_change_requests')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!data || data.length === 0) return;

    const pendingIds = new Set(
      (await db.customerChangeRequests.where('synced').equals(0).toArray()).map((r) =>
        String(r.id)
      )
    );

    const mapped = data
      .filter((r) => !pendingIds.has(String(r.id)))
      .map((r) => ({
        id: String(r.id),
        customerId: r.customer_id,
        type: r.type,
        proposedChanges: r.proposed_changes || null,
        status: r.status,
        requestedById: r.requested_by || null,
        requestedByEmail: r.requested_by_email || 'unknown',
        requestedByRole: r.requested_by_role || 'unknown',
        createdAt: r.created_at,
        decidedByEmail: r.decided_by_email || null,
        decidedAt: r.decided_at || null,
        rejectionReason: r.rejection_reason || null,
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.customerChangeRequests.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch customer change requests:', err.message);
  }
}

export async function syncPendingCustomerChangeRequestsToCloud() {
  try {
    const pending = await db.customerChangeRequests.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const request of pending) {
      const { error } = await supabase.from('customer_change_requests').upsert([
        {
          id: request.id,
          customer_id: request.customerId,
          type: request.type,
          proposed_changes: request.proposedChanges,
          status: request.status,
          requested_by: request.requestedById,
          requested_by_email: request.requestedByEmail,
          requested_by_role: request.requestedByRole,
          created_at: request.createdAt,
          decided_by_email: request.decidedByEmail,
          decided_at: request.decidedAt,
          rejection_reason: request.rejectionReason
        }
      ]);
      if (!error) await db.customerChangeRequests.update(request.id, { synced: 1 });
    }
  } catch (err) {
    console.warn('Unable to sync pending customer change requests:', err.message);
  }
}

// Returns the minimum a wholesale customer must pay on a new ticket
// before it can be approved: whatever they already owed coming in.
// They're allowed to let the NEW purchase itself add to their balance
// (that's the point — owing is an incentive to buy more) but the OLD
// balance has to be cleared first.
export function getMinimumWholesalePayment(customer) {
  return Math.max(0, Number(customer?.balance || 0));
}

// Called once a wholesale ticket's payment has been confirmed as
// sufficient (see approveTicket below, which calls this instead of
// doing the arithmetic inline). Moves the customer's balance forward
// by (ticketTotal - amountPaid) — positive if they still owe something
// after this purchase, negative if they overpaid and the pharmacy now
// owes THEM. Returns the before/after snapshot so it can be stamped
// onto the sale record for the receipt and sales history.
export async function recordWholesalePayment(customerId, ticketTotal, amountPaid, actor) {
  const customer = await db.customers.get(customerId);
  const balanceBefore = Number(customer?.balance || 0);
  const balanceAfter = balanceBefore + Number(ticketTotal || 0) - Number(amountPaid || 0);

  if (customer) {
    await db.customers.update(customerId, {
      balance: balanceAfter,
      balanceDirty: 1,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        const result = await applyCloudCustomerBalanceDelta(
          customerId,
          balanceAfter - balanceBefore,
          balanceAfter
        );
        if (result.ok) {
          await db.customers.update(customerId, {
            balance: result.balance,
            balanceDirty: 0,
            synced: 1
          });
        }
      } catch (err) {
        console.warn('Cloud customer balance update postponed:', err.message);
      }
    }
  }

  await logAuditEvent({
    actorEmail: actor?.email,
    actorRole: actor?.role,
    action: 'customer_balance_updated',
    targetType: 'customer',
    targetId: customerId,
    details: { balanceBefore, balanceAfter, ticketTotal, amountPaid }
  });

  return { balanceBefore, balanceAfter };
}

// Actually moves the stock: for each line item, either tops up an
// existing drug (stock += quantity, cost price updated to what this
// supplier charged) or creates the new drug the line describes, with
// its starting stock set to the quantity received. Shared by both the
// "manager enters stock directly" path and the "manager approves a
// cashier's pending entry" path below.
// Returns the same item list back with every new-drug line's `drugId`
// filled in with the id it was actually created under, so the stock
// entry itself always ends up pointing at real drug ids once applied —
// needed for editing an already-applied entry later (see
// applyStockEntryEditDelta below), which has to know exactly which drug
// each line affected.
async function applyStockEntryToDrugs(entry) {
  const resolvedItems = [];
  // Collected here and recorded AFTER the transaction below commits —
  // recordDrugPriceChoice does its own db.drugs.get/update, and keeping
  // that outside the transaction avoids nesting a second read-modify
  // cycle on the same table inside the one already in progress.
  const priceChoicesToRecord = [];

  await db.transaction('rw', db.drugs, async () => {
    for (const item of entry.items) {
      if (item.isNewDrug) {
        const newId = item.drugId || generateId('DRUG');
        const existing = await db.drugs.get(newId);
        if (existing) {
          // Extremely unlikely id collision — fold into the existing
          // row instead of silently overwriting it.
          await db.drugs.update(newId, {
            stock: (existing.stock || 0) + Number(item.quantity || 0),
            costPrice: Number(item.costPrice || existing.costPrice || 0),
            synced: 0
          });
        } else {
          await db.drugs.add({
            id: newId,
            name: item.name,
            unitType: item.unitType || 'Unit',
            costPrice: Number(item.costPrice || 0),
            retailPrice: Number(item.retailPrice || 0),
            wholesalePrice: Number(item.wholesalePrice || 0),
            stock: Number(item.quantity || 0),
            barcode: item.barcode || '',
            halfPackQty: item.halfPackQty ?? null,
            halfPackPrice: item.halfPackPrice ?? null,
            packQty: item.packQty ?? null,
            packPrice: item.packPrice ?? null,
            synced: 0
          });
        }
        resolvedItems.push({ ...item, drugId: newId });
        priceChoicesToRecord.push({
          drugId: newId,
          costPrice: item.costPrice,
          retailPrice: item.retailPrice,
          wholesalePrice: item.wholesalePrice
        });
      } else if (item.drugId) {
        const existingDrug =
          (await db.drugs.get(String(item.drugId))) ||
          (await db.drugs.get(Number(item.drugId)));
        if (existingDrug) {
          // Cost, retail and wholesale price all come pre-filled from
          // the catalog in the UI but stay editable — if the person
          // changed them (this supplier/delivery priced it
          // differently), the drug record picks up the new price too,
          // not just the stock bump.
          const updates = {
            stock: (existingDrug.stock || 0) + Number(item.quantity || 0),
            synced: 0
          };
          if (item.costPrice !== undefined && item.costPrice !== null) {
            updates.costPrice = Number(item.costPrice);
          }
          if (item.retailPrice !== undefined && item.retailPrice !== null) {
            updates.retailPrice = Number(item.retailPrice);
          }
          if (item.wholesalePrice !== undefined && item.wholesalePrice !== null) {
            updates.wholesalePrice = Number(item.wholesalePrice);
          }
          await db.drugs.update(existingDrug.id, updates);
          priceChoicesToRecord.push({
            drugId: existingDrug.id,
            costPrice: updates.costPrice ?? existingDrug.costPrice,
            retailPrice: updates.retailPrice ?? existingDrug.retailPrice,
            wholesalePrice: updates.wholesalePrice ?? existingDrug.wholesalePrice
          });
        }
        resolvedItems.push(item);
      } else {
        resolvedItems.push(item);
      }
    }
  });

  // Learn from every price that was actually set on this delivery, new
  // drug or restock of an existing one alike.
  for (const choice of priceChoicesToRecord) {
    await recordDrugPriceChoice(
      choice.drugId,
      choice.costPrice,
      choice.retailPrice,
      choice.wholesalePrice
    );
  }

  // Push every drug this just touched (or created) up to the cloud. The
  // generic drug-sync retry already covers it if this fails or the
  // device is offline — this is just for immediate freshness.
  if (navigator.onLine) {
    await syncPendingDrugsToCloud();
  }

  return resolvedItems;
}

// Applying an EDIT to a stock entry that's already APPLIED (stock
// already moved) can't just re-run applyStockEntryToDrugs — that would
// double-count. Instead this works out, per line, how much the
// quantity changed since the entry was first applied and nudges stock
// by just that difference, and overwrites cost/retail/wholesale/pack
// prices to whatever the edit set them to. Deliberately scoped to
// modifying or removing lines that were already part of the entry —
// adding a brand-new line during an edit isn't supported (that's a new
// delivery, i.e. a new stock entry); every line in `newItems` must
// already have a `drugId` that was in `oldItems`.
async function applyStockEntryEditDelta(oldItems, newItems) {
  await db.transaction('rw', db.drugs, async () => {
    const newByDrugId = new Map(
      newItems.filter((it) => it.drugId).map((it) => [String(it.drugId), it])
    );

    for (const oldIt of oldItems) {
      if (!oldIt.drugId) continue;

      const key = String(oldIt.drugId);
      const newIt = newByDrugId.get(key);
      const oldQty = Number(oldIt.quantity || 0);
      const newQty = newIt ? Number(newIt.quantity || 0) : 0; // line removed entirely
      const quantityDelta = newQty - oldQty;

      const existingDrug =
        (await db.drugs.get(oldIt.drugId)) || (await db.drugs.get(Number(oldIt.drugId)));
      if (!existingDrug) continue;

      const updates = { synced: 0 };
      if (quantityDelta !== 0) {
        updates.stock = Math.max(0, (existingDrug.stock || 0) + quantityDelta);
      }
      if (newIt) {
        if (newIt.costPrice !== undefined && newIt.costPrice !== null) {
          updates.costPrice = Number(newIt.costPrice);
        }
        if (newIt.retailPrice !== undefined && newIt.retailPrice !== null) {
          updates.retailPrice = Number(newIt.retailPrice);
        }
        if (newIt.wholesalePrice !== undefined && newIt.wholesalePrice !== null) {
          updates.wholesalePrice = Number(newIt.wholesalePrice);
        }
        if (newIt.isNewDrug) {
          if (newIt.halfPackQty !== undefined) updates.halfPackQty = newIt.halfPackQty;
          if (newIt.halfPackPrice !== undefined) updates.halfPackPrice = newIt.halfPackPrice;
          if (newIt.packQty !== undefined) updates.packQty = newIt.packQty;
          if (newIt.packPrice !== undefined) updates.packPrice = newIt.packPrice;
        }
      }

      if (Object.keys(updates).length > 1) {
        await db.drugs.update(existingDrug.id, updates);
      }
    }
  });

  if (navigator.onLine) {
    await syncPendingDrugsToCloud();
  }
}

const STOCK_ENTRY_EDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function createStockEntry(payload, actor) {
  try {
    const role = actor?.role;
    const status = role === 'manager' || role === 'administrator'
      ? 'APPLIED'
      : 'PENDING';

    const entry = {
      id: generateId('STOCK'),
      status,
      supplierId: payload.supplierId,
      supplierName: payload.supplierName,
      items: payload.items,
      totalCost: payload.totalCost,
      // What was handed to the supplier at the time, if any — tracked
      // separately from totalCost so "amount owed" (totalCost -
      // amountPaid) can be worked out per entry and per supplier.
      amountPaid: Number(payload.amountPaid) || 0,
      enteredById: actor?.id || null,
      enteredByEmail: actor?.email || 'unknown',
      enteredByRole: role || 'unknown',
      createdAt: new Date().toISOString(),
      decidedByEmail: null,
      decidedAt: null,
      rejectionReason: null,
      synced: 0
    };

    await db.stockEntries.add(entry);

    if (status === 'APPLIED') {
      // New-drug lines only get a real drugId once applyStockEntryToDrugs
      // actually creates them — write that back onto both the in-memory
      // entry (used for the cloud insert below) and the local Dexie
      // record (already written above with unresolved items), so a
      // later edit can tell exactly which drug each line affects.
      entry.items = await applyStockEntryToDrugs(entry);
      await db.stockEntries.update(entry.id, { items: entry.items });
    }

    if (navigator.onLine) {
      try {
        const { error } = await supabase.from('stock_entries').insert([
          {
            id: entry.id,
            status: entry.status,
            supplier_id: entry.supplierId,
            supplier_name: entry.supplierName,
            items: entry.items,
            total_cost: entry.totalCost,
            amount_paid: entry.amountPaid,
            entered_by: entry.enteredById,
            entered_by_email: entry.enteredByEmail,
            entered_by_role: entry.enteredByRole,
            created_at: entry.createdAt,
            decided_by_email: entry.decidedByEmail,
            decided_at: entry.decidedAt,
            rejection_reason: entry.rejectionReason
          }
        ]);
        if (!error) await db.stockEntries.update(entry.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud stock entry create postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: status === 'APPLIED' ? 'stock_entry_applied' : 'stock_entry_requested',
      targetType: 'stock_entry',
      targetId: entry.id,
      details: {
        supplierName: entry.supplierName,
        itemCount: entry.items.length,
        totalCost: entry.totalCost
      }
    });

    return { success: true, entry };
  } catch (err) {
    console.warn('Unable to create stock entry:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function approveStockEntry(entry, actor) {
  try {
    const freshLocal = await db.stockEntries.get(entry.id);
    if (freshLocal && freshLocal.status !== 'PENDING') {
      return { success: false, reason: 'This stock entry has already been handled.' };
    }

    const target = freshLocal || entry;
    const resolvedItems = await applyStockEntryToDrugs(target);

    const decidedAt = new Date().toISOString();

    await db.stockEntries.update(entry.id, {
      status: 'APPLIED',
      items: resolvedItems,
      decidedByEmail: actor?.email || 'unknown',
      decidedAt,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('stock_entries')
          .update({
            status: 'APPLIED',
            items: resolvedItems,
            decided_by_email: actor?.email || 'unknown',
            decided_at: decidedAt
          })
          .eq('id', entry.id);
        if (!error) await db.stockEntries.update(entry.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud stock entry approval postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'stock_entry_approved',
      targetType: 'stock_entry',
      targetId: entry.id,
      details: { supplierName: target.supplierName, totalCost: target.totalCost }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to approve stock entry:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function rejectStockEntry(entry, reason, actor) {
  try {
    const decidedAt = new Date().toISOString();
    const trimmedReason = (reason || '').trim();

    await db.stockEntries.update(entry.id, {
      status: 'REJECTED',
      rejectionReason: trimmedReason,
      decidedByEmail: actor?.email || 'unknown',
      decidedAt,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('stock_entries')
          .update({
            status: 'REJECTED',
            rejection_reason: trimmedReason,
            decided_by_email: actor?.email || 'unknown',
            decided_at: decidedAt
          })
          .eq('id', entry.id);
        if (!error) await db.stockEntries.update(entry.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud stock entry rejection postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'stock_entry_rejected',
      targetType: 'stock_entry',
      targetId: entry.id,
      details: { reason: trimmedReason }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to reject stock entry:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function fetchCloudStockEntries() {
  try {
    // A year, not 30 days — this is also what backs the Stock History
    // page now, which needs more than a month of lookback to be useful.
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const { data, error } = await supabase
      .from('stock_entries')
      .select('*')
      .gte('created_at', oneYearAgo.toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!data || data.length === 0) return;

    const pendingIds = new Set(
      (await db.stockEntries.where('synced').equals(0).toArray()).map((e) =>
        String(e.id)
      )
    );

    const mapped = data
      .filter((e) => !pendingIds.has(String(e.id)))
      .map((e) => ({
        id: String(e.id),
        status: e.status,
        supplierId: e.supplier_id,
        supplierName: e.supplier_name,
        items: e.items || [],
        totalCost: Number(e.total_cost || 0),
        amountPaid: Number(e.amount_paid || 0),
        enteredById: e.entered_by || null,
        enteredByEmail: e.entered_by_email || 'unknown',
        enteredByRole: e.entered_by_role || 'unknown',
        createdAt: e.created_at,
        decidedByEmail: e.decided_by_email || null,
        decidedAt: e.decided_at || null,
        rejectionReason: e.rejection_reason || null,
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.stockEntries.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch stock entries from cloud:', err.message);
  }
}

export async function syncPendingStockEntriesToCloud() {
  try {
    const pending = await db.stockEntries.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const entry of pending) {
      const { error } = await supabase.from('stock_entries').upsert([
        {
          id: entry.id,
          status: entry.status,
          supplier_id: entry.supplierId,
          supplier_name: entry.supplierName,
          items: entry.items,
          total_cost: entry.totalCost,
          amount_paid: entry.amountPaid ?? 0,
          entered_by: entry.enteredById,
          entered_by_email: entry.enteredByEmail,
          entered_by_role: entry.enteredByRole,
          created_at: entry.createdAt,
          decided_by_email: entry.decidedByEmail,
          decided_at: entry.decidedAt,
          rejection_reason: entry.rejectionReason
        }
      ]);
      if (!error) await db.stockEntries.update(entry.id, { synced: 1 });
    }
  } catch (err) {
    console.warn('Unable to sync pending stock entries:', err.message);
  }
}

// Logging a payment made to a supplier against this entry — separate
// from editStockEntry/the 7-day correction window, since paying off a
// debt can happen weeks later and shouldn't be time-boxed the way
// correcting a data-entry mistake is. Adds to whatever's already been
// paid (so several partial payments over time just accumulate); applies
// immediately for cashier or manager alike — it only moves a running
// paid total, nothing about stock or the catalog.
export async function recordSupplierPayment(entry, additionalAmount, actor) {
  try {
    const amount = Number(additionalAmount) || 0;
    if (amount <= 0) {
      return { success: false, reason: 'Enter an amount greater than 0.' };
    }

    const freshLocal = await db.stockEntries.get(entry.id);
    const target = freshLocal || entry;
    const newAmountPaid = Number(target.amountPaid || 0) + amount;

    await db.stockEntries.update(entry.id, {
      amountPaid: newAmountPaid,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('stock_entries')
          .update({ amount_paid: newAmountPaid })
          .eq('id', entry.id);
        if (!error) await db.stockEntries.update(entry.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud supplier payment postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'supplier_payment_recorded',
      targetType: 'stock_entry',
      targetId: entry.id,
      details: {
        supplierName: target.supplierName,
        amount,
        newAmountPaid,
        totalCost: target.totalCost
      }
    });

    return { success: true, amountPaid: newAmountPaid };
  } catch (err) {
    console.warn('Unable to record supplier payment:', err.message);
    return { success: false, reason: err.message };
  }
}

// Exported so App.jsx can grey out an "Edit" button for an entry once
// it's too old, without duplicating the seven-day rule.
export const STOCK_ENTRY_EDIT_WINDOW_DAYS = 7;

// Correcting a mistake in a stock entry — wrong quantity, wrong price, a
// line that shouldn't have been there — within a week of it being
// entered, even one that's already APPLIED (stock already moved).
// `newItems` is the corrected full item list (same shape as the
// original entry's items; a line can be dropped entirely by leaving it
// out). Who can edit what:
//  - The entry's own creator, or any manager/administrator, can edit it
//    (a cashier can't touch someone else's entry).
//  - If the entry is still PENDING (nothing applied to stock yet), the
//    edit just overwrites it in place — there's nothing live to
//    protect, and it's still subject to the original approve/reject.
//  - If the entry is already APPLIED, a manager/administrator's edit
//    recalculates the stock delta and applies it immediately; a
//    cashier's edit is recorded as a PENDING stockEntryEdits request
//    instead, and does nothing to stock until a manager approves it.
export async function editStockEntry(entry, newItems, actor) {
  try {
    const freshLocal = await db.stockEntries.get(entry.id);
    if (!freshLocal) {
      return { success: false, reason: 'This stock entry could not be found.' };
    }

    if (freshLocal.status === 'REJECTED') {
      return {
        success: false,
        reason: 'This entry was rejected — create a new stock entry instead of editing it.'
      };
    }

    const ageMs = Date.now() - new Date(freshLocal.createdAt).getTime();
    if (ageMs > STOCK_ENTRY_EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
      return {
        success: false,
        reason: `This entry is more than ${STOCK_ENTRY_EDIT_WINDOW_DAYS} days old and can no longer be edited.`
      };
    }

    const isOwner = freshLocal.enteredByEmail === actor?.email;
    const isManager = actor?.role === 'manager' || actor?.role === 'administrator';
    if (!isOwner && !isManager) {
      return { success: false, reason: "You can only edit your own stock entries." };
    }

    const newTotalCost = newItems.reduce(
      (sum, item) => sum + Number(item.quantity || 0) * Number(item.costPrice || 0),
      0
    );

    if (freshLocal.status === 'PENDING') {
      // Nothing has touched stock yet — just correct the pending
      // request in place, whoever is editing it.
      await db.stockEntries.update(entry.id, {
        items: newItems,
        totalCost: newTotalCost,
        synced: 0
      });

      if (navigator.onLine) {
        try {
          const { error } = await supabase
            .from('stock_entries')
            .update({ items: newItems, total_cost: newTotalCost })
            .eq('id', entry.id);
          if (!error) await db.stockEntries.update(entry.id, { synced: 1 });
        } catch (err) {
          console.warn('Cloud stock entry edit postponed:', err.message);
        }
      }

      await logAuditEvent({
        actorEmail: actor?.email,
        actorRole: actor?.role,
        action: 'stock_entry_edited',
        targetType: 'stock_entry',
        targetId: entry.id,
        details: { supplierName: freshLocal.supplierName, totalCost: newTotalCost }
      });

      return { success: true, applied: true };
    }

    // freshLocal.status === 'APPLIED' from here on.
    if (isManager) {
      await applyStockEntryEditDelta(freshLocal.items, newItems);

      await db.stockEntries.update(entry.id, {
        items: newItems,
        totalCost: newTotalCost,
        synced: 0
      });

      if (navigator.onLine) {
        try {
          const { error } = await supabase
            .from('stock_entries')
            .update({ items: newItems, total_cost: newTotalCost })
            .eq('id', entry.id);
          if (!error) await db.stockEntries.update(entry.id, { synced: 1 });
        } catch (err) {
          console.warn('Cloud stock entry edit postponed:', err.message);
        }
      }

      await logAuditEvent({
        actorEmail: actor?.email,
        actorRole: actor?.role,
        action: 'stock_entry_edited',
        targetType: 'stock_entry',
        targetId: entry.id,
        details: { supplierName: freshLocal.supplierName, totalCost: newTotalCost }
      });

      return { success: true, applied: true };
    }

    // Cashier editing their own already-APPLIED entry — queue it
    // instead of touching stock directly.
    const editRequest = {
      id: generateId('STOCKEDIT'),
      stockEntryId: entry.id,
      originalItems: freshLocal.items,
      proposedItems: newItems,
      proposedTotalCost: newTotalCost,
      status: 'PENDING',
      requestedById: actor?.id || null,
      requestedByEmail: actor?.email || 'unknown',
      requestedByRole: actor?.role || 'unknown',
      createdAt: new Date().toISOString(),
      decidedByEmail: null,
      decidedAt: null,
      rejectionReason: null,
      synced: 0
    };

    await db.stockEntryEdits.add(editRequest);

    if (navigator.onLine) {
      try {
        const { error } = await supabase.from('stock_entry_edits').insert([
          {
            id: editRequest.id,
            stock_entry_id: editRequest.stockEntryId,
            original_items: editRequest.originalItems,
            proposed_items: editRequest.proposedItems,
            proposed_total_cost: editRequest.proposedTotalCost,
            status: editRequest.status,
            requested_by: editRequest.requestedById,
            requested_by_email: editRequest.requestedByEmail,
            requested_by_role: editRequest.requestedByRole,
            created_at: editRequest.createdAt,
            decided_by_email: editRequest.decidedByEmail,
            decided_at: editRequest.decidedAt,
            rejection_reason: editRequest.rejectionReason
          }
        ]);
        if (!error) await db.stockEntryEdits.update(editRequest.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud stock entry edit request postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'stock_entry_edit_requested',
      targetType: 'stock_entry',
      targetId: entry.id,
      details: { supplierName: freshLocal.supplierName, proposedTotalCost: newTotalCost }
    });

    return { success: true, applied: false, pending: true };
  } catch (err) {
    console.warn('Unable to edit stock entry:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function approveStockEntryEdit(editRequest, actor) {
  try {
    const freshEdit = await db.stockEntryEdits.get(editRequest.id);
    if (freshEdit && freshEdit.status !== 'PENDING') {
      return { success: false, reason: 'This edit request has already been handled.' };
    }
    const target = freshEdit || editRequest;

    const stockEntry = await db.stockEntries.get(target.stockEntryId);
    if (!stockEntry) {
      return { success: false, reason: 'The original stock entry could not be found.' };
    }

    await applyStockEntryEditDelta(stockEntry.items, target.proposedItems);

    await db.stockEntries.update(stockEntry.id, {
      items: target.proposedItems,
      totalCost: target.proposedTotalCost,
      synced: 0
    });

    const decidedAt = new Date().toISOString();
    await db.stockEntryEdits.update(target.id, {
      status: 'APPROVED',
      decidedByEmail: actor?.email || 'unknown',
      decidedAt,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        await supabase
          .from('stock_entries')
          .update({ items: target.proposedItems, total_cost: target.proposedTotalCost })
          .eq('id', stockEntry.id);
        await db.stockEntries.update(stockEntry.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud stock entry (from edit) sync postponed:', err.message);
      }
      try {
        const { error } = await supabase
          .from('stock_entry_edits')
          .update({
            status: 'APPROVED',
            decided_by_email: actor?.email || 'unknown',
            decided_at: decidedAt
          })
          .eq('id', target.id);
        if (!error) await db.stockEntryEdits.update(target.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud stock entry edit approval postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'stock_entry_edit_approved',
      targetType: 'stock_entry',
      targetId: stockEntry.id,
      details: { editRequestId: target.id, totalCost: target.proposedTotalCost }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to approve stock entry edit:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function rejectStockEntryEdit(editRequest, reason, actor) {
  try {
    const decidedAt = new Date().toISOString();
    const trimmedReason = (reason || '').trim();

    await db.stockEntryEdits.update(editRequest.id, {
      status: 'REJECTED',
      rejectionReason: trimmedReason,
      decidedByEmail: actor?.email || 'unknown',
      decidedAt,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('stock_entry_edits')
          .update({
            status: 'REJECTED',
            rejection_reason: trimmedReason,
            decided_by_email: actor?.email || 'unknown',
            decided_at: decidedAt
          })
          .eq('id', editRequest.id);
        if (!error) await db.stockEntryEdits.update(editRequest.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud stock entry edit rejection postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'stock_entry_edit_rejected',
      targetType: 'stock_entry',
      targetId: editRequest.stockEntryId,
      details: { reason: trimmedReason }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to reject stock entry edit:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function fetchCloudStockEntryEdits() {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const { data, error } = await supabase
      .from('stock_entry_edits')
      .select('*')
      .gte('created_at', thirtyDaysAgo.toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!data || data.length === 0) return;

    const pendingIds = new Set(
      (await db.stockEntryEdits.where('synced').equals(0).toArray()).map((e) =>
        String(e.id)
      )
    );

    const mapped = data
      .filter((e) => !pendingIds.has(String(e.id)))
      .map((e) => ({
        id: String(e.id),
        stockEntryId: e.stock_entry_id,
        originalItems: e.original_items || [],
        proposedItems: e.proposed_items || [],
        proposedTotalCost: Number(e.proposed_total_cost || 0),
        status: e.status,
        requestedById: e.requested_by || null,
        requestedByEmail: e.requested_by_email || 'unknown',
        requestedByRole: e.requested_by_role || 'unknown',
        createdAt: e.created_at,
        decidedByEmail: e.decided_by_email || null,
        decidedAt: e.decided_at || null,
        rejectionReason: e.rejection_reason || null,
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.stockEntryEdits.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch stock entry edits from cloud:', err.message);
  }
}

export async function syncPendingStockEntryEditsToCloud() {
  try {
    const pending = await db.stockEntryEdits.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const editRequest of pending) {
      const { error } = await supabase.from('stock_entry_edits').upsert([
        {
          id: editRequest.id,
          stock_entry_id: editRequest.stockEntryId,
          original_items: editRequest.originalItems,
          proposed_items: editRequest.proposedItems,
          proposed_total_cost: editRequest.proposedTotalCost,
          status: editRequest.status,
          requested_by: editRequest.requestedById,
          requested_by_email: editRequest.requestedByEmail,
          requested_by_role: editRequest.requestedByRole,
          created_at: editRequest.createdAt,
          decided_by_email: editRequest.decidedByEmail,
          decided_at: editRequest.decidedAt,
          rejection_reason: editRequest.rejectionReason
        }
      ]);
      if (!error) await db.stockEntryEdits.update(editRequest.id, { synced: 1 });
    }
  } catch (err) {
    console.warn('Unable to sync pending stock entry edits:', err.message);
  }
}

// ============================================================
// AUTOMATED PURCHASE LIST
// ------------------------------------------------------------
// Scans the catalog for anything finished (stock 0) or below its
// configured minimum (minStockQty — optional per drug), and for each
// one works out which supplier it's usually bought from by counting
// how often that supplier shows up across past APPLIED stock entries
// for that exact drug (ties broken by whichever was more recent). A
// drug with no purchase history yet is still listed, just without a
// recommended supplier. This is pure computation — nothing is written
// until the person saves the list.
// ============================================================
export async function generatePurchaseList() {
  const [allDrugs, allEntries] = await Promise.all([
    db.drugs.toArray(),
    db.stockEntries.where('status').equals('APPLIED').toArray()
  ]);

  const liveDrugs = allDrugs.filter((d) => !d.deletedAt);

  const needsRestocking = liveDrugs.filter((d) => {
    const stock = Number(d.stock || 0);
    const min = d.minStockQty !== null && d.minStockQty !== undefined
      ? Number(d.minStockQty)
      : null;
    return stock <= 0 || (min !== null && stock < min);
  });

  // For each drug id: supplierId -> { count, lastSeenAt, supplierName }
  const historyByDrug = new Map();
  for (const entry of allEntries) {
    if (!entry.supplierId) continue;
    for (const item of entry.items || []) {
      if (!item.drugId) continue;
      const key = String(item.drugId);
      if (!historyByDrug.has(key)) historyByDrug.set(key, new Map());
      const bySupplier = historyByDrug.get(key);
      const existing = bySupplier.get(entry.supplierId) || {
        count: 0,
        lastSeenAt: entry.createdAt,
        supplierName: entry.supplierName
      };
      existing.count += 1;
      if (new Date(entry.createdAt) > new Date(existing.lastSeenAt)) {
        existing.lastSeenAt = entry.createdAt;
      }
      bySupplier.set(entry.supplierId, existing);
    }
  }

  const recommendedSupplierFor = (drugId) => {
    const bySupplier = historyByDrug.get(String(drugId));
    if (!bySupplier || bySupplier.size === 0) return null;

    let best = null;
    for (const [supplierId, stat] of bySupplier.entries()) {
      if (
        !best ||
        stat.count > best.count ||
        (stat.count === best.count &&
          new Date(stat.lastSeenAt) > new Date(best.lastSeenAt))
      ) {
        best = { supplierId, ...stat };
      }
    }
    return best ? { supplierId: best.supplierId, supplierName: best.supplierName } : null;
  };

  const items = needsRestocking.map((d) => {
    const recommended = recommendedSupplierFor(d.id);
    const min = d.minStockQty !== null && d.minStockQty !== undefined
      ? Number(d.minStockQty)
      : null;
    // No configured recommended quantity: fall back to "enough to get
    // back to double the minimum," or just the minimum if that's all
    // that's set, or a conservative default of 10 if neither is set —
    // always editable either way.
    const fallbackQty =
      d.recommendedPurchaseQty ??
      (min !== null ? Math.max(min * 2 - Number(d.stock || 0), min) : 10);

    return {
      drugId: d.id,
      drugName: d.name,
      unitType: d.unitType,
      currentStock: Number(d.stock || 0),
      minStockQty: min,
      quantity: Math.max(1, Math.round(Number(fallbackQty) || 10)),
      supplierId: recommended?.supplierId || null,
      supplierName: recommended?.supplierName || null
    };
  });

  return { items };
}

export async function fetchCloudPurchaseLists() {
  try {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    const { data, error } = await supabase
      .from('purchase_lists')
      .select('*')
      .gte('created_at', oneYearAgo.toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!data || data.length === 0) return;

    const pendingIds = new Set(
      (await db.purchaseLists.where('synced').equals(0).toArray()).map((p) =>
        String(p.id)
      )
    );

    const mapped = data
      .filter((p) => !pendingIds.has(String(p.id)))
      .map((p) => ({
        id: String(p.id),
        title: p.title || '',
        items: p.items || [],
        createdById: p.created_by || null,
        createdByEmail: p.created_by_email || 'unknown',
        createdAt: p.created_at,
        updatedAt: p.updated_at || p.created_at,
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.purchaseLists.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch purchase lists from cloud:', err.message);
  }
}

export async function syncPendingPurchaseListsToCloud() {
  try {
    const pending = await db.purchaseLists.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const list of pending) {
      const { error } = await supabase.from('purchase_lists').upsert([
        {
          id: list.id,
          title: list.title,
          items: list.items,
          created_by: list.createdById,
          created_by_email: list.createdByEmail,
          created_at: list.createdAt,
          updated_at: list.updatedAt
        }
      ]);
      if (!error) await db.purchaseLists.update(list.id, { synced: 1 });
    }
  } catch (err) {
    console.warn('Unable to sync pending purchase lists:', err.message);
  }
}

// Saves a purchase list for the first time (no id yet) or updates one
// already saved (id passed in) — either way it's just a personal/team
// planning document, so no approval chain: whoever's working on it
// (cashier or manager) can save and keep re-editing it freely.
export async function savePurchaseList(list, actor) {
  try {
    const now = new Date().toISOString();
    const isNew = !list.id;

    const record = {
      id: list.id || generateId('PURCHLIST'),
      title: list.title || `Purchase List — ${new Date().toLocaleDateString()}`,
      items: list.items || [],
      createdById: list.createdById || actor?.id || null,
      createdByEmail: list.createdByEmail || actor?.email || 'unknown',
      createdAt: list.createdAt || now,
      updatedAt: now,
      synced: 0
    };

    await db.purchaseLists.put(record);

    if (navigator.onLine) {
      try {
        const { error } = await supabase.from('purchase_lists').upsert([
          {
            id: record.id,
            title: record.title,
            items: record.items,
            created_by: record.createdById,
            created_by_email: record.createdByEmail,
            created_at: record.createdAt,
            updated_at: record.updatedAt
          }
        ]);
        if (!error) await db.purchaseLists.update(record.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud purchase list save postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: isNew ? 'purchase_list_created' : 'purchase_list_updated',
      targetType: 'purchase_list',
      targetId: record.id,
      details: { title: record.title, itemCount: record.items.length }
    });

    return { success: true, list: record };
  } catch (err) {
    console.warn('Unable to save purchase list:', err.message);
    return { success: false, reason: err.message };
  }
}

export async function deletePurchaseList(id, actor) {
  try {
    await db.purchaseLists.delete(id);
    if (navigator.onLine) {
      try {
        await supabase.from('purchase_lists').delete().eq('id', id);
      } catch (err) {
        console.warn('Cloud purchase list delete postponed:', err.message);
      }
    }
    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'purchase_list_deleted',
      targetType: 'purchase_list',
      targetId: id
    });
    return { success: true };
  } catch (err) {
    console.warn('Unable to delete purchase list:', err.message);
    return { success: false, reason: err.message };
  }
}

// ============================================================
// PURCHASE PLANS — one persistent row per drug, replacing the old
// "generate a snapshot, save it, reopen it" flow. A drug's desired
// purchase quantity, chosen supplier override and "not to buy right
// now" flag live here continuously; there is no separate save step —
// every change (a quantity edit, picking a supplier, excluding a
// drug) is written straight to this table as it happens. No approval
// chain either, same as the old purchase lists — it's a planning tool,
// not something that changes stock or money on its own.
// ============================================================

export async function fetchCloudPurchasePlans() {
  try {
    const { data, error } = await supabase.from('purchase_plans').select('*');
    if (error) throw error;
    if (!data || data.length === 0) return;

    const pendingIds = new Set(
      (await db.purchasePlans.where('synced').equals(0).toArray()).map((p) =>
        String(p.drugId)
      )
    );

    const mapped = data
      .filter((p) => !pendingIds.has(String(p.drug_id)))
      .map((p) => ({
        drugId: String(p.drug_id),
        quantity: p.quantity ?? null,
        unitCost: p.unit_cost ?? null,
        supplierId: p.supplier_id || null,
        supplierName: p.supplier_name || null,
        supplierManual: Boolean(p.supplier_manual),
        excluded: Boolean(p.excluded),
        updatedAt: p.updated_at,
        updatedByEmail: p.updated_by_email || 'unknown',
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.purchasePlans.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch purchase plans from cloud:', err.message);
  }
}

export async function syncPendingPurchasePlansToCloud() {
  try {
    const pending = await db.purchasePlans.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const plan of pending) {
      const { error } = await supabase.from('purchase_plans').upsert([
        {
          drug_id: plan.drugId,
          quantity: plan.quantity,
          unit_cost: plan.unitCost,
          supplier_id: plan.supplierId,
          supplier_name: plan.supplierName,
          supplier_manual: plan.supplierManual,
          excluded: plan.excluded,
          updated_at: plan.updatedAt,
          updated_by_email: plan.updatedByEmail
        }
      ]);
      if (!error) await db.purchasePlans.update(plan.drugId, { synced: 1 });
    }
  } catch (err) {
    console.warn('Unable to sync pending purchase plans:', err.message);
  }
}

// Merges `changes` into this drug's plan row (creating it if this is
// the first time the drug's purchase plan has been touched). Pass
// `supplierManual: true` whenever the change came from the person
// explicitly picking a supplier — that's what makes the choice sticky
// instead of silently drifting back to "last supplier bought from" as
// soon as a new delivery arrives.
export async function savePurchasePlan(drugId, changes, actor) {
  try {
    const existing = await db.purchasePlans.get(drugId);
    const record = {
      drugId,
      quantity: existing?.quantity ?? null,
      unitCost: existing?.unitCost ?? null,
      supplierId: existing?.supplierId ?? null,
      supplierName: existing?.supplierName ?? null,
      supplierManual: existing?.supplierManual ?? false,
      excluded: existing?.excluded ?? false,
      ...changes,
      updatedAt: new Date().toISOString(),
      updatedByEmail: actor?.email || 'unknown',
      synced: 0
    };

    await db.purchasePlans.put(record);

    if (navigator.onLine) {
      try {
        const { error } = await supabase.from('purchase_plans').upsert([
          {
            drug_id: record.drugId,
            quantity: record.quantity,
            unit_cost: record.unitCost,
            supplier_id: record.supplierId,
            supplier_name: record.supplierName,
            supplier_manual: record.supplierManual,
            excluded: record.excluded,
            updated_at: record.updatedAt,
            updated_by_email: record.updatedByEmail
          }
        ]);
        if (!error) await db.purchasePlans.update(record.drugId, { synced: 1 });
      } catch (err) {
        console.warn('Cloud purchase plan save postponed:', err.message);
      }
    }

    return { success: true, plan: record };
  } catch (err) {
    console.warn('Unable to save purchase plan:', err.message);
    return { success: false, reason: err.message };
  }
}

// Works out which supplier a drug was most recently bought from, by
// scanning APPLIED stock entries — the same "last/most frequent
// supplier" signal the old generatePurchaseList used, now exposed on
// its own so the UI can show it as the live default any time a drug
// has no manual supplier override on its plan.
export async function getLastSupplierForDrug(drugId) {
  try {
    const entries = await db.stockEntries
      .where('status')
      .equals('APPLIED')
      .toArray();

    let best = null;
    for (const entry of entries) {
      if (!entry.supplierId) continue;
      for (const item of entry.items || []) {
        if (String(item.drugId) !== String(drugId)) continue;
        if (!best || new Date(entry.createdAt) > new Date(best.lastSeenAt)) {
          best = {
            supplierId: entry.supplierId,
            supplierName: entry.supplierName,
            lastSeenAt: entry.createdAt
          };
        }
      }
    }
    return best;
  } catch (err) {
    console.warn('Unable to look up last supplier for drug:', err.message);
    return null;
  }
}

// ============================================================
// RESTOCK DRAFT (per-account, local-only, not synced to the cloud)
// ------------------------------------------------------------
// The restock screen's in-progress work — which supplier, which drugs
// added so far — persists across tab switches and page reloads so a
// cashier/manager can step away to attend a customer and pick back up
// later. Keyed by the account's email so switching to a DIFFERENT
// account on the same device never shows one person's unsaved work to
// another. Deliberately local-only: this is scratch/WIP state, not a
// real record, so it doesn't need a `synced` flag or a cloud table —
// it just doesn't follow the account to a different device.
// ============================================================
export async function getRestockDraft(email) {
  if (!email) return null;
  try {
    return (await db.restockDrafts.get(email)) || null;
  } catch (err) {
    console.warn('Unable to read restock draft:', err.message);
    return null;
  }
}

export async function saveRestockDraft(email, draftData) {
  if (!email) return;
  try {
    await db.restockDrafts.put({
      id: email,
      ...draftData,
      updatedAt: new Date().toISOString()
    });
  } catch (err) {
    console.warn('Unable to save restock draft:', err.message);
  }
}

export async function clearRestockDraft(email) {
  if (!email) return;
  try {
    await db.restockDrafts.delete(email);
  } catch (err) {
    console.warn('Unable to clear restock draft:', err.message);
  }
}

// ============================================================
// SAVED CART DRAFTS
// ------------------------------------------------------------
// A draft an attendant is actively juggling lives only in React state
// (see ticketDrafts in App.jsx) — still true, and still never synced.
// But a draft the attendant wants to set aside and come back to later
// (after closing the tab, the end of a shift, tomorrow) gets written
// here instead, purely local (never pushed to Supabase — a half-built
// cart isn't something other devices need to see). Scoped to whichever
// attendant saved it.
// ============================================================

export async function saveCartDraft(draft, actor) {
  try {
    const record = {
      id: draft.id || generateId('CARTDRAFT'),
      attendantEmail: actor?.email || '',
      label: draft.customerName || 'Saved cart',
      customerName: draft.customerName || '',
      customerPhone: draft.customerPhone || '',
      saleType: draft.saleType || 'retail',
      items: draft.items || [],
      savedAt: new Date().toISOString()
    };
    await db.cartDrafts.put(record);
    return { success: true, draft: record };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

export async function fetchSavedCartDrafts(attendantEmail) {
  try {
    const all = await db.cartDrafts
      .where('attendantEmail')
      .equals(attendantEmail || '')
      .toArray();
    return all.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  } catch (err) {
    console.warn('Unable to fetch saved cart drafts:', err.message);
    return [];
  }
}

export async function deleteCartDraft(id) {
  try {
    await db.cartDrafts.delete(id);
    return { success: true };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ============================================================
// ATTENDANT / CASHIER TICKET WORKFLOW
// ------------------------------------------------------------
// DRAFT tickets (an attendant still building a customer's cart) live
// only in React state in App.jsx — they're never written here, so
// there's nothing to sync or clean up for them. A ticket only reaches
// this file once an attendant submits it, at which point it's created
// directly in PENDING_PAYMENT status: printed for the customer to carry
// to the cashier, and visible to every cashier/manager/administrator
// device via fetchCloudTickets(), not just the attendant's own device.
// ============================================================

// YYYY-MM-DD in the browser's own local timezone (not UTC), so "today"
// lines up with when the pharmacy's day actually starts/ends.
function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// "Customer #1, #2, #3..." for the day, assigned the moment a ticket is
// submitted (ready for payment) — not when the draft was created — so
// the number reflects arrival order at the till. This has to be an
// atomic database increment (next_daily_ticket_number, added in
// migration_v6): two attendants on two different devices could submit
// within the same second, and a locally-computed "count + 1" could hand
// both of them the same number.
async function getNextDailyTicketNumber() {
  if (navigator.onLine) {
    try {
      const { data, error } = await supabase.rpc('next_daily_ticket_number', {
        p_date: localDateKey()
      });
      if (!error && typeof data === 'number') return data;
      if (error) console.warn('Daily ticket number RPC error:', error.message);
    } catch (err) {
      console.warn('Daily ticket number RPC failed:', err.message);
    }
  }

  // Offline fallback (or the function isn't deployed yet): best-effort
  // count of today's local tickets + 1. Not race-safe across devices,
  // but better than no number — the common case (online) uses the
  // atomic function above.
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todays = await db.tickets
      .filter((t) => new Date(t.createdAt) >= todayStart)
      .toArray();
    return todays.length + 1;
  } catch {
    return null;
  }
}

// ============================================================
// TICKET CLOUD HELPERS
// ------------------------------------------------------------
// One mapper each way, so every code path that sends or receives a
// ticket (create, retry-sync, live pull, realtime push, claim) agrees on
// the exact same field list. Before this, each path had its own
// hand-copied list and they drifted apart (a missing column in one
// silently broke ticket delivery between terminals).
// ============================================================
function ticketToCloudRow(t) {
  return {
    id: t.id,
    status: t.status,
    items: t.items,
    total: t.total,
    sale_type: t.saleType,
    customer_name: t.customerName,
    customer_phone: t.customerPhone,
    customer_id: t.customerId || null,
    daily_number: t.dailyNumber ?? null,
    adjustment_reason: t.adjustmentReason ?? null,
    sent_back_at: t.sentBackAt ?? null,
    attendant_id: t.attendantId,
    attendant_email: t.attendantEmail,
    cashier_id: t.cashierId || null,
    cashier_email: t.cashierEmail || null,
    payment_method: t.paymentMethod || null,
    sale_id: t.saleId || null,
    created_at: t.createdAt,
    paid_at: t.paidAt || null
  };
}

export function mapCloudTicket(t) {
  return {
    id: String(t.id),
    status: t.status,
    items: t.items || [],
    total: Number(t.total || 0),
    saleType: t.sale_type || 'retail',
    customerName: t.customer_name || '',
    customerPhone: t.customer_phone || '',
    customerId: t.customer_id || null,
    dailyNumber: t.daily_number ?? null,
    adjustmentReason: t.adjustment_reason || null,
    sentBackAt: t.sent_back_at || null,
    attendantId: t.attendant_id,
    attendantEmail: t.attendant_email,
    cashierId: t.cashier_id || null,
    cashierEmail: t.cashier_email || null,
    paymentMethod: t.payment_method || null,
    saleId: t.sale_id || null,
    createdAt: t.created_at,
    paidAt: t.paid_at || null,
    synced: 1
  };
}

// Writes cloud ticket rows into the local table, EXCEPT any ticket this
// device still has unsynced local changes for (synced: 0) — those win
// until they've been pushed.
async function mergeCloudTicketRows(rows) {
  if (!rows || rows.length === 0) return 0;
  const pendingIds = new Set(
    (await db.tickets.where('synced').equals(0).toArray()).map((t) =>
      String(t.id)
    )
  );
  const mapped = rows
    .filter((t) => !pendingIds.has(String(t.id)))
    .map(mapCloudTicket);
  if (mapped.length > 0) await db.tickets.bulkPut(mapped);
  return mapped.length;
}

// Pushes ONE local ticket to the cloud safely:
//   - not in the cloud yet  -> insert it
//   - already finished in the cloud by someone else (PAID / CANCELLED /
//     EXPIRED) and different from ours -> don't clobber it; tell the
//     caller to adopt the cloud copy instead
//   - otherwise -> update, but only if the row is still in the status we
//     just looked at (so we can't overwrite a change made in between)
// Returns { ok, adoptCloud?, error? }.
async function pushTicketToCloud(ticket) {
  const { data: existing, error: lookupError } = await supabase
    .from('tickets')
    .select('id,status')
    .eq('id', ticket.id)
    .maybeSingle();
  if (lookupError) return { ok: false, error: lookupError };

  const row = ticketToCloudRow(ticket);

  if (!existing) {
    const { error } = await supabase.from('tickets').insert([row]);
    if (error) return { ok: false, error };
    return { ok: true };
  }

  const cloudFinished = ['PAID', 'CANCELLED', 'EXPIRED'].includes(
    existing.status
  );
  if (cloudFinished && existing.status !== ticket.status) {
    return { ok: true, adoptCloud: true };
  }

  const { data: updated, error } = await supabase
    .from('tickets')
    .update(row)
    .eq('id', ticket.id)
    .eq('status', existing.status)
    .select('id');
  if (error) return { ok: false, error };
  if (!updated || updated.length === 0) {
    // Changed under us between the lookup and the update — leave it
    // unsynced; the next retry looks at the fresh state.
    return { ok: false, error: new Error('Ticket changed in the cloud — will retry.') };
  }
  return { ok: true };
}

// Marks a ticket delivered after a push, or swaps in the cloud copy.
async function settleTicketPush(ticket, result) {
  if (!result.ok) return false;
  if (result.adoptCloud) {
    const { data } = await supabase
      .from('tickets')
      .select('*')
      .eq('id', ticket.id)
      .maybeSingle();
    if (data) await db.tickets.put(mapCloudTicket(data));
    else await db.tickets.update(ticket.id, { synced: 1 });
    return true;
  }
  await db.tickets.update(ticket.id, { synced: 1 });
  return true;
}

// Atomic stock change (+/-) applied on the SERVER, so two terminals
// selling the same drug at the same moment both count — the old way
// (each terminal wrote its own absolute "stock = N") let the last
// writer erase the other's sale. Needs migration v18's
// adjust_drug_stock(); if that function isn't deployed yet it falls
// back to the old absolute write so nothing breaks in the meantime.
async function applyCloudStockDelta(drugId, delta, localStockAfter) {
  const id = String(drugId);
  try {
    const { data, error } = await supabase.rpc('adjust_drug_stock', {
      p_id: id,
      p_delta: delta
    });
    if (!error && data !== null && data !== undefined) {
      return { ok: true, stock: Number(data) };
    }
    if (error) console.warn('adjust_drug_stock RPC unavailable, using fallback:', error.message);
  } catch (err) {
    console.warn('adjust_drug_stock RPC failed, using fallback:', err.message);
  }
  try {
    const { error } = await supabase
      .from('drugs')
      .update({ stock: localStockAfter })
      .eq('id', id);
    if (!error) return { ok: true, stock: localStockAfter };
  } catch (err) {
    console.warn('Cloud stock fallback failed:', err.message);
  }
  return { ok: false };
}

// Exported wrapper for App.jsx's direct-checkout path.
export async function pushDrugStockDelta(drugId, delta, localStockAfter) {
  const result = await applyCloudStockDelta(drugId, delta, localStockAfter);
  if (result.ok) {
    await db.drugs.update(
      (await db.drugs.get(String(drugId))) ? String(drugId) : Number(drugId),
      { stock: result.stock, synced: 1 }
    );
  }
  return result;
}

// Same idea for a wholesale customer's running balance.
async function applyCloudCustomerBalanceDelta(customerId, delta, localBalanceAfter) {
  const id = String(customerId);
  try {
    const { data, error } = await supabase.rpc('adjust_customer_balance', {
      p_id: id,
      p_delta: delta
    });
    if (!error && data !== null && data !== undefined) {
      return { ok: true, balance: Number(data) };
    }
    if (error) console.warn('adjust_customer_balance RPC unavailable, using fallback:', error.message);
  } catch (err) {
    console.warn('adjust_customer_balance RPC failed, using fallback:', err.message);
  }
  try {
    const { error } = await supabase
      .from('customers')
      .update({ balance: localBalanceAfter })
      .eq('id', id);
    if (!error) return { ok: true, balance: localBalanceAfter };
  } catch (err) {
    console.warn('Cloud customer balance fallback failed:', err.message);
  }
  return { ok: false };
}

// Claims a ticket for this cashier in the cloud. Returns
//   { ok: true }                      - claimed (or already ours, unfinished)
//   { ok: true, offline: true }       - couldn't reach the cloud at all
//   { ok: false, reason }             - genuinely taken, with the REAL why
// Crucially it first makes sure the ticket actually EXISTS in the cloud.
// The old version skipped that, so a ticket whose first upload had
// failed matched zero rows and was wrongly reported as "already
// approved by someone else".
async function claimTicketInCloud(ticket, actor) {
  try {
    const local = await db.tickets.get(ticket.id);
    if (local && Number(local.synced) === 0) {
      const pushed = await pushTicketToCloud(local);
      if (pushed.ok && !pushed.adoptCloud) {
        await db.tickets.update(ticket.id, { synced: 1 });
      } else if (pushed.adoptCloud) {
        await settleTicketPush(local, pushed);
        return {
          ok: false,
          reason: 'This ticket was already handled by someone else.'
        };
      } else {
        throw pushed.error || new Error('Could not upload ticket.');
      }
    }

    const { data: claimed, error: claimError } = await supabase
      .from('tickets')
      .update({
        status: 'PAID',
        cashier_id: actor?.id,
        cashier_email: actor?.email
      })
      .eq('id', ticket.id)
      .eq('status', 'PENDING_PAYMENT')
      .select('id');
    if (claimError) throw claimError;
    if (claimed && claimed.length > 0) return { ok: true };

    // Zero rows: find out the real reason instead of guessing.
    const { data: row, error: rowError } = await supabase
      .from('tickets')
      .select('*')
      .eq('id', ticket.id)
      .maybeSingle();
    if (rowError) throw rowError;

    if (row) await mergeCloudTicketRows([row]);

    if (!row) {
      return {
        ok: false,
        reason:
          'This ticket could not be found in the cloud. Check your connection and try again.'
      };
    }
    // A previous attempt by THIS cashier claimed it but never finished
    // (page closed mid-approval) — let them finish it.
    if (row.status === 'PAID' && !row.sale_id && row.cashier_id === actor?.id) {
      return { ok: true };
    }
    if (row.status === 'PAID') {
      return {
        ok: false,
        reason: `This ticket was already approved${row.cashier_email ? ` by ${row.cashier_email}` : ''}.`
      };
    }
    if (row.status === 'CANCELLED') {
      return { ok: false, reason: 'This ticket was cancelled.' };
    }
    if (row.status === 'EXPIRED') {
      return { ok: false, reason: 'This ticket expired before it was approved.' };
    }
    if (row.status === 'SENT_BACK') {
      return {
        ok: false,
        reason: 'This ticket was sent back to the attendant for changes.'
      };
    }
    return { ok: false, reason: 'This ticket is no longer awaiting payment.' };
  } catch (err) {
    console.warn('Ticket claim check failed, proceeding offline-style:', err.message);
    return { ok: true, offline: true };
  }
}

// Undo a claim when approval failed after it succeeded, so the ticket
// goes back into the queue instead of being stuck "PAID" with no sale.
async function releaseTicketClaim(ticketId, actor) {
  try {
    await supabase
      .from('tickets')
      .update({ status: 'PENDING_PAYMENT', cashier_id: null, cashier_email: null })
      .eq('id', ticketId)
      .eq('status', 'PAID')
      .is('sale_id', null);
  } catch (err) {
    console.warn('Could not release ticket claim:', err.message);
  }
}

export async function createTicket(ticketPayload, actor) {
  // Same ₦0-ticket guard as App.jsx, duplicated here so a bug anywhere
  // else that calls this directly can't slip a free "sale" through.
  if (!ticketPayload.total || ticketPayload.total <= 0) {
    return {
      success: false,
      reason: `This ticket's total (₦${ticketPayload.total || 0}) can't be submitted — check item pricing first.`
    };
  }

  // A wholesale sale no longer needs a registered customer just to be
  // sent to the cashier — wholesale pricing and owing are separate
  // things now. A customer record only matters if this person wants to
  // owe and pay later; that gets attached (if at all) at the cashier's
  // approval stage via linkCustomerToTicket, not here.

  const dailyNumber = await getNextDailyTicketNumber();

  const ticket = {
    ...ticketPayload,
    id: ticketPayload.id || generateId('TICKET'),
    status: 'PENDING_PAYMENT',
    dailyNumber,
    createdAt: new Date().toISOString(),
    synced: 0
  };

  try {
    await db.tickets.add(ticket);
  } catch (err) {
    console.warn('Unable to write ticket locally:', err.message);
    return { success: false, reason: err.message };
  }

  let delivered = false;
  let deliveryError = null;
  if (navigator.onLine) {
    try {
      const pushed = await pushTicketToCloud(ticket);
      if (pushed.ok) {
        delivered = await settleTicketPush(ticket, pushed);
      } else {
        deliveryError = pushed.error?.message || 'unknown error';
        console.warn('Cloud ticket creation postponed:', deliveryError);
      }
    } catch (err) {
      deliveryError = err.message;
      console.warn('Cloud ticket creation postponed:', err.message);
    }
  }

  await logAuditEvent({
    actorEmail: actor?.email,
    actorRole: actor?.role,
    action: 'ticket_created',
    targetType: 'ticket',
    targetId: ticket.id,
    details: { total: ticket.total, customerName: ticket.customerName }
  });

  return { success: true, ticket, delivered, deliveryError };
}

// ------------------------------------------------------------
// LIVE TICKET REFRESH — runs every few seconds on every terminal.
// Deliberately small so it's cheap to run constantly (egress!):
//   1. every ticket that's still open in the cloud (pending / sent back)
//   2. any ticket THIS device still thinks is open but that wasn't in
//      (1) — i.e. someone approved/cancelled it — fetched by id so the
//      stale queue entry disappears
//   3. tickets from the last 2 hours (so recent PAID/CANCELLED ones show)
// plus pushes any ticket this device hasn't managed to upload yet.
// Returns { newPendingCount } for callers that want to react.
// ------------------------------------------------------------
export async function fetchLiveTickets() {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  try {
    // Push first: anything stuck local-only gets another chance.
    await syncPendingTicketsToCloud();

    const { data: open, error } = await supabase
      .from('tickets')
      .select('*')
      .in('status', ['PENDING_PAYMENT', 'SENT_BACK'])
      .order('created_at', { ascending: false })
      .limit(300);
    if (error) throw error;

    const openRows = open || [];
    const openIds = new Set(openRows.map((r) => String(r.id)));

    const localOpen = await db.tickets
      .filter(
        (t) =>
          (t.status === 'PENDING_PAYMENT' || t.status === 'SENT_BACK') &&
          Number(t.synced) !== 0 &&
          !openIds.has(String(t.id))
      )
      .toArray();

    let closedRows = [];
    if (localOpen.length > 0) {
      const { data: closed } = await supabase
        .from('tickets')
        .select('*')
        .in(
          'id',
          localOpen.map((t) => t.id)
        );
      closedRows = closed || [];
      // A "synced" local ticket that no longer exists in the cloud at all
      // (deleted by an admin) shouldn't sit in the queue forever.
      const foundIds = new Set(closedRows.map((r) => String(r.id)));
      for (const t of localOpen) {
        if (!foundIds.has(String(t.id))) {
          await db.tickets.update(t.id, { status: 'CANCELLED' });
        }
      }
    }

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { data: recent } = await supabase
      .from('tickets')
      .select('*')
      .gte('created_at', twoHoursAgo.toISOString())
      .order('created_at', { ascending: false })
      .limit(300);

    const byId = new Map();
    [...(recent || []), ...closedRows, ...openRows].forEach((r) =>
      byId.set(String(r.id), r)
    );
    await mergeCloudTicketRows([...byId.values()]);
  } catch (err) {
    console.warn('Live ticket refresh failed:', err.message);
  }
}

// Pulls one ticket row (from a Realtime push) into the local table.
export async function applyRealtimeTicketRow(row) {
  try {
    if (!row || !row.id) return;
    await mergeCloudTicketRows([row]);
  } catch (err) {
    console.warn('Realtime ticket apply failed:', err.message);
  }
}

// Pulls every ticket from the last 2 days down from Supabase, so a
// cashier's queue shows tickets created by ANY attendant on ANY device,
// not just ones submitted from this device. The 2-day window (rather
// than "pending only") also lets a just-approved/cancelled ticket still
// show briefly in a shared "recent tickets" view for cross-checking.
// Same pending-write guard as syncDrugsFromCloud: a ticket this device
// has unsynced local changes for (synced: 0) is never overwritten by a
// stale cloud copy.
export async function fetchCloudTickets() {
  try {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    const { data, error } = await supabase
      .from('tickets')
      .select('*')
      .gte('created_at', twoDaysAgo.toISOString())
      .order('created_at', { ascending: false });

    if (error) throw error;
    await mergeCloudTicketRows(data || []);
  } catch (err) {
    console.warn('Unable to fetch tickets from cloud:', err.message);
  }
}

let ticketPushInFlight = false;
export async function syncPendingTicketsToCloud() {
  if (ticketPushInFlight) return;
  ticketPushInFlight = true;
  try {
    const pending = await db.tickets.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const ticket of pending) {
      try {
        const result = await pushTicketToCloud(ticket);
        if (result.ok) {
          await settleTicketPush(ticket, result);
        } else {
          console.warn('Ticket push postponed:', result.error?.message);
        }
      } catch (err) {
        console.warn('Ticket push postponed:', err.message);
      }
    }
  } catch (err) {
    console.warn('Unable to sync pending tickets:', err.message);
  } finally {
    ticketPushInFlight = false;
  }
}

// A PENDING_PAYMENT ticket older than this with no cashier action is
// treated as abandoned (customer walked off, or never made it to the
// till). This is only checked opportunistically — whenever a device
// loads the Tickets tab — there's no server-side cron doing this, so a
// ticket won't flip to EXPIRED until some device with the app open
// happens to notice. Good enough for a single-location pharmacy; worth
// revisiting if that ever stops being true.
const TICKET_EXPIRY_MINUTES = 30;

export async function expireStaleTickets() {
  try {
    const cutoff = new Date();
    cutoff.setMinutes(cutoff.getMinutes() - TICKET_EXPIRY_MINUTES);

    const pending = await db.tickets
      .where('status')
      .equals('PENDING_PAYMENT')
      .toArray();

    const stale = pending.filter((t) => new Date(t.createdAt) < cutoff);
    if (stale.length === 0) return;

    for (const ticket of stale) {
      await db.tickets.update(ticket.id, {
        status: 'EXPIRED',
        synced: 0
      });

      if (navigator.onLine) {
        try {
          // Only expire if the cloud row is STILL pending — if another
          // terminal approved it in the meantime, never overwrite PAID.
          const { data: expired, error } = await supabase
            .from('tickets')
            .update({ status: 'EXPIRED' })
            .eq('id', ticket.id)
            .eq('status', 'PENDING_PAYMENT')
            .select('id');
          if (!error) {
            if (expired && expired.length > 0) {
              await db.tickets.update(ticket.id, { synced: 1 });
            } else {
              // Not pending in the cloud any more — take the real state.
              const { data: real } = await supabase
                .from('tickets')
                .select('*')
                .eq('id', ticket.id)
                .maybeSingle();
              if (real) await db.tickets.put(mapCloudTicket(real));
            }
          }
        } catch (err) {
          console.warn('Cloud ticket expiry postponed:', err.message);
        }
      }
    }
  } catch (err) {
    console.warn('Unable to expire stale tickets:', err.message);
  }
}

export async function cancelTicket(ticket, actor) {
  try {
    // Cloud first (when online) with a status guard: cancelling a ticket
    // that another terminal has just approved must NOT flip a paid sale
    // back to cancelled.
    if (navigator.onLine) {
      try {
        const local = await db.tickets.get(ticket.id);
        if (local && Number(local.synced) === 0) {
          const pushed = await pushTicketToCloud(local);
          if (pushed.ok) await settleTicketPush(local, pushed);
        }
        const { data: cancelled, error } = await supabase
          .from('tickets')
          .update({ status: 'CANCELLED' })
          .eq('id', ticket.id)
          .in('status', ['PENDING_PAYMENT', 'SENT_BACK'])
          .select('id');
        if (error) throw error;
        if (!cancelled || cancelled.length === 0) {
          const { data: real } = await supabase
            .from('tickets')
            .select('*')
            .eq('id', ticket.id)
            .maybeSingle();
          if (real) await db.tickets.put(mapCloudTicket(real));
          if (real && real.status === 'CANCELLED') return { success: true };
          return {
            success: false,
            reason: 'This ticket has already been handled by someone else.'
          };
        }
        await db.tickets.update(ticket.id, { status: 'CANCELLED', synced: 1 });
      } catch (err) {
        console.warn('Cloud ticket cancel postponed:', err.message);
        await db.tickets.update(ticket.id, { status: 'CANCELLED', synced: 0 });
      }
    } else {
      await db.tickets.update(ticket.id, { status: 'CANCELLED', synced: 0 });
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'ticket_cancelled',
      targetType: 'ticket',
      targetId: ticket.id,
      details: { total: ticket.total }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to cancel ticket:', err.message);
    return { success: false, reason: err.message };
  }
}

// A cashier can't fix a customer's cart themselves — no touching drugs
// or quantities on the cashier side — so instead of cancelling and
// losing the sale, they send the ticket back to whoever built it with a
// short reason ("customer can't afford item X", "forgot to add Y").
// The attendant then reopens it as an editable draft and resubmits,
// which turns it back into PENDING_PAYMENT via resubmitTicket below —
// the ticket itself (its id, and its daily arrival number) is reused
// rather than recreated, since it already had its place in line.
export async function sendTicketBack(ticket, reason, actor) {
  try {
    const freshLocal = await db.tickets.get(ticket.id);
    if (freshLocal && freshLocal.status !== 'PENDING_PAYMENT') {
      return {
        success: false,
        reason: 'This ticket has already been handled.'
      };
    }

    const trimmedReason = (reason || '').trim();
    const sentBackAt = new Date().toISOString();

    let cloudDone = false;
    if (navigator.onLine) {
      try {
        const local = await db.tickets.get(ticket.id);
        if (local && Number(local.synced) === 0) {
          const pushed = await pushTicketToCloud(local);
          if (pushed.ok) await settleTicketPush(local, pushed);
        }
        const { data: moved, error } = await supabase
          .from('tickets')
          .update({
            status: 'SENT_BACK',
            adjustment_reason: trimmedReason,
            sent_back_at: sentBackAt
          })
          .eq('id', ticket.id)
          .eq('status', 'PENDING_PAYMENT')
          .select('id');
        if (error) throw error;
        if (!moved || moved.length === 0) {
          const { data: real } = await supabase
            .from('tickets')
            .select('*')
            .eq('id', ticket.id)
            .maybeSingle();
          if (real) await db.tickets.put(mapCloudTicket(real));
          return {
            success: false,
            reason: 'This ticket has already been handled by someone else.'
          };
        }
        cloudDone = true;
      } catch (err) {
        console.warn('Cloud ticket send-back postponed:', err.message);
      }
    }

    await db.tickets.update(ticket.id, {
      status: 'SENT_BACK',
      adjustmentReason: trimmedReason,
      sentBackAt,
      synced: cloudDone ? 1 : 0
    });

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'ticket_sent_back',
      targetType: 'ticket',
      targetId: ticket.id,
      details: {
        reason: trimmedReason,
        customerName: ticket.customerName,
        attendantEmail: ticket.attendantEmail
      }
    });

    return { success: true };
  } catch (err) {
    console.warn('Unable to send ticket back:', err.message);
    return { success: false, reason: err.message };
  }
}

// The attendant's side of the above: reopening a SENT_BACK ticket as an
// editable draft (done in App.jsx) and resubmitting it lands here. The
// same ticket id and daily number are kept — this is still "that
// customer's" place in the queue, just with corrected contents — and
// the ticket flips back to PENDING_PAYMENT for the cashier to see again.
export async function resubmitTicket(ticketId, updatedPayload, actor) {
  try {
    const freshLocal = await db.tickets.get(ticketId);
    if (!freshLocal) {
      return { success: false, reason: 'Original ticket could not be found.' };
    }
    if (freshLocal.status !== 'SENT_BACK') {
      return {
        success: false,
        reason: 'This ticket is no longer waiting for adjustment.'
      };
    }

    if (!updatedPayload.total || updatedPayload.total <= 0) {
      return {
        success: false,
        reason: `This ticket's total (₦${updatedPayload.total || 0}) can't be resubmitted — check item pricing (e.g. after toggling retail/wholesale) before sending it back to the cashier.`
      };
    }

    // No customer requirement here either, same reasoning as
    // createTicket above — resubmitting a wholesale ticket doesn't need
    // anyone picked.

    const update = {
      items: updatedPayload.items,
      total: updatedPayload.total,
      saleType: updatedPayload.saleType,
      customerName: updatedPayload.customerName,
      customerPhone: updatedPayload.customerPhone,
      customerId: updatedPayload.customerId || null,
      status: 'PENDING_PAYMENT',
      adjustmentReason: null,
      sentBackAt: null,
      synced: 0
    };

    await db.tickets.update(ticketId, update);

    if (navigator.onLine) {
      try {
        const local = await db.tickets.get(ticketId);
        const pushed = await pushTicketToCloud(local);
        if (pushed.ok) await settleTicketPush(local, pushed);
        else console.warn('Cloud ticket resubmit postponed:', pushed.error?.message);
      } catch (err) {
        console.warn('Cloud ticket resubmit postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'ticket_resubmitted',
      targetType: 'ticket',
      targetId: ticketId,
      details: { total: update.total, customerName: update.customerName }
    });

    const freshest = await db.tickets.get(ticketId);
    return { success: true, ticket: freshest };
  } catch (err) {
    console.warn('Unable to resubmit ticket:', err.message);
    return { success: false, reason: err.message };
  }
}

// Floors any drug already sitting at a negative stock count (from
// before every write path clamped at 0) up to 0, locally and in the
// cloud. Safe to call repeatedly — it's a no-op once nothing is
// negative anymore.
export async function clampNegativeStockToZero() {
  try {
    const negative = await db.drugs
      .filter((d) => Number(d.stock || 0) < 0)
      .toArray();
    if (negative.length === 0) return;

    for (const drug of negative) {
      await db.drugs.update(drug.id, { stock: 0, synced: 0 });
    }

    if (navigator.onLine) {
      for (const drug of negative) {
        try {
          const { error } = await supabase
            .from('drugs')
            .update({ stock: 0 })
            .eq('id', drug.id);
          if (!error) await db.drugs.update(drug.id, { synced: 1 });
        } catch (err) {
          console.warn('Cloud negative-stock clamp postponed:', err.message);
        }
      }
    }
  } catch (err) {
    console.warn('Unable to clamp negative stock:', err.message);
  }
}

// ============================================================
// WHOLESALE CUSTOMER DYNAMIC
// ------------------------------------------------------------
// A wholesale ticket no longer needs a registered customer just to be
// built and sent to the cashier (see createTicket/resubmitTicket
// above) — a customer record is only needed when the person actually
// wants to owe and pay later. That decision happens at the cashier's
// end, during approval, which is what this function is for: it
// attaches an EXISTING, already-approved customer to a ticket that was
// submitted without one, right before approveTicket is called. Once
// linked, approveTicket's own owed-balance logic (further down)
// applies exactly as it already did.
//
// A customer created moments ago by a cashier's own CREATE request
// (see addCustomer) can't be linked here — they don't exist in
// `customers` at all yet, only as a PENDING customerChangeRequests row,
// precisely because a brand-new customer isn't allowed to owe until a
// manager approves them. That sale just has to be paid in full, same
// as a walk-in.
// ============================================================
export async function linkCustomerToTicket(ticket, customerId, actor) {
  try {
    const customer = await db.customers.get(customerId);
    if (!customer) {
      return { success: false, reason: 'Customer not found.' };
    }
    if (customer.deletedAt) {
      return { success: false, reason: 'This customer has been deleted.' };
    }

    const changes = {
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phone || ticket.customerPhone || '',
      synced: 0
    };

    await db.tickets.update(ticket.id, changes);

    if (navigator.onLine) {
      try {
        const local = await db.tickets.get(ticket.id);
        const pushed = await pushTicketToCloud(local);
        if (pushed.ok) await settleTicketPush(local, pushed);
      } catch (err) {
        console.warn('Cloud ticket-customer link postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'ticket_customer_linked',
      targetType: 'ticket',
      targetId: ticket.id,
      details: { customerId: customer.id, customerName: customer.name }
    });

    return { success: true, ticket: { ...ticket, ...changes } };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// The cashier-approval step: this is where a ticket actually becomes a
// real sale. `paymentBreakdown` is { cash, bank, bankOption, card } —
// whichever of cash/bank/card aren't used are 0. Stock is deducted the
// same way handleCheckout does it for a direct sale, a `sales` row is
// created (so Sales History, the audit log, and the drug-accountability
// search all pick it up for free), and the ticket itself is marked PAID
// with a link back to that sale.
export async function approveTicket(ticket, paymentBreakdown, actor) {
  try {
    if (!ticket.total || ticket.total <= 0) {
      return {
        success: false,
        reason: `This ticket's total (₦${ticket.total || 0}) can't be approved — send it back to the attendant instead.`
      };
    }

    const amountPaid =
      Number(paymentBreakdown?.cash || 0) +
      (paymentBreakdown?.electronic || []).reduce(
        (sum, line) => sum + Number(line.amount || 0),
        0
      );

    // Wholesale customers are allowed to owe (it's an incentive to buy
    // more) but whatever they already owed coming in has to be cleared
    // before a NEW purchase is let through — the new ticket's own total
    // can still go fully or partly unpaid. Checked before any stock or
    // ticket state changes so a short payment never gets halfway in.
    let customerBalanceBefore = null;
    let customerBalanceAfter = null;
    if (ticket.saleType === 'wholesale' && ticket.customerId) {
      // Another terminal may have just changed this customer's balance
      // (a payment, a return, another sale) — use the cloud's figure,
      // not a possibly-stale local copy, for the minimum-payment check.
      if (navigator.onLine) {
        try {
          const { data: cloudCustomer } = await supabase
            .from('customers')
            .select('balance')
            .eq('id', ticket.customerId)
            .maybeSingle();
          const localCustomer = await db.customers.get(ticket.customerId);
          if (
            cloudCustomer &&
            localCustomer &&
            Number(localCustomer.synced) !== 0
          ) {
            await db.customers.update(ticket.customerId, {
              balance: Number(cloudCustomer.balance || 0)
            });
          }
        } catch (err) {
          console.warn('Customer balance refresh skipped:', err.message);
        }
      }
      const customer = await db.customers.get(ticket.customerId);
      const balanceBefore = Number(customer?.balance || 0);
      const minimumRequired = Math.max(0, balanceBefore);
      if (amountPaid + 1 < minimumRequired) {
        return {
          success: false,
          insufficientWholesalePayment: true,
          minimumRequired,
          balanceBefore,
          reason: `${customer?.name || 'This customer'} still owes ₦${minimumRequired.toLocaleString()} from before — at least that much has to be paid before this sale can go through.`
        };
      }
      customerBalanceBefore = balanceBefore;
      customerBalanceAfter = balanceBefore + ticket.total - amountPaid;
    }

    // Guard #1 (same device): if this device's own local copy already
    // moved on from PENDING_PAYMENT — a second click, or a stale queue
    // that hasn't re-rendered yet — stop here before touching stock.
    const freshLocal = await db.tickets.get(ticket.id);
    if (freshLocal && freshLocal.status !== 'PENDING_PAYMENT') {
      return {
        success: false,
        reason: 'This ticket has already been handled.'
      };
    }

    // Guard #2 (different devices/accounts): claim the ticket in the
    // cloud. claimTicketInCloud first makes sure the ticket really
    // exists there (uploading it if its first upload failed), then does
    // the conditional PENDING_PAYMENT -> PAID flip, and on a genuine
    // loss reports the REAL reason (who approved it / cancelled / sent
    // back) instead of a guess.
    let claimedInCloud = false;
    if (navigator.onLine) {
      const claim = await claimTicketInCloud(ticket, actor);
      if (!claim.ok) {
        return { success: false, reason: claim.reason };
      }
      claimedInCloud = !claim.offline;
    }

    const saleId = generateId('SALE');
    const paidAt = new Date().toISOString();

    const saleData = {
      id: saleId,
      total: ticket.total,
      saleType: ticket.saleType,
      cashierId: actor?.id,
      cashierEmail: actor?.email,
      attendantId: ticket.attendantId,
      attendantEmail: ticket.attendantEmail,
      customerName: ticket.customerName,
      customerPhone: ticket.customerPhone,
      customerId: ticket.customerId || null,
      amountPaid,
      customerBalanceBefore,
      customerBalanceAfter,
      items: ticket.items,
      paymentMethod: paymentBreakdown,
      ticketId: ticket.id,
      createdAt: paidAt,
      synced: 0
    };

    const stockChanges = [];
    try {
    await db.transaction('rw', db.drugs, db.sales, db.tickets, db.customers, async () => {
      // Re-check one more time inside the transaction, in case a
      // fetchCloudTickets() triggered by something else slipped this
      // ticket's status out from under us between the checks above and
      // here.
      const txTicket = await db.tickets.get(ticket.id);
      if (txTicket && txTicket.status === 'PAID' && txTicket.saleId && txTicket.saleId !== saleId) {
        throw new Error('This ticket has already been handled.');
      }

      for (const item of ticket.items) {
        if (!item.id) continue;
        const drugKey = String(item.id);
        const existingDrug =
          (await db.drugs.get(drugKey)) || (await db.drugs.get(Number(item.id)));

        if (existingDrug) {
          // Stock is never allowed to go negative — clamp at 0. A sale is
          // still recorded in full even if the pharmacy was already
          // short on physical stock; only the recorded count floors out.
          const newStock = Math.max(0, (existingDrug.stock || 0) - item.quantity);
          await db.drugs.update(existingDrug.id, {
            stock: newStock,
            synced: 0
          });
          stockChanges.push({
            drugKey,
            localId: existingDrug.id,
            quantity: Number(item.quantity),
            newStock
          });
        }
      }

      await db.sales.add(saleData);

      await db.tickets.update(ticket.id, {
        status: 'PAID',
        cashierId: actor?.id,
        cashierEmail: actor?.email,
        paymentMethod: paymentBreakdown,
        saleId,
        paidAt,
        synced: 0
      });

      if (ticket.saleType === 'wholesale' && ticket.customerId) {
        await db.customers.update(ticket.customerId, {
          balance: customerBalanceAfter,
          balanceDirty: 1,
          synced: 0
        });
      }
    });
    } catch (txErr) {
      // Local save failed AFTER we claimed it in the cloud — put the
      // ticket back in the queue so it isn't stranded as "paid".
      if (claimedInCloud) await releaseTicketClaim(ticket.id, actor);
      throw txErr;
    }

    if (ticket.saleType === 'wholesale' && ticket.customerId && navigator.onLine) {
      try {
        const result = await applyCloudCustomerBalanceDelta(
          ticket.customerId,
          Number(ticket.total) - amountPaid,
          customerBalanceAfter
        );
        if (result.ok) {
          await db.customers.update(ticket.customerId, {
            balance: result.balance,
            balanceDirty: 0,
            synced: 1
          });
        }
      } catch (err) {
        console.warn('Cloud customer balance update postponed:', err.message);
      }
    }

    if (navigator.onLine) {
      // Push the stock changes, the new sale, and the ticket update to
      // the cloud. Each piece retries independently on the next
      // reconnect (via syncPendingDrugsToCloud / syncPendingSalesToCloud
      // / syncPendingTicketsToCloud) if any of these calls fail here.
      for (const change of stockChanges) {
        try {
          const result = await applyCloudStockDelta(
            change.drugKey,
            -change.quantity,
            change.newStock
          );
          if (result.ok) {
            await db.drugs.update(change.localId, {
              stock: result.stock,
              synced: 1
            });
          }
        } catch (err) {
          console.warn('Cloud stock update postponed:', err.message);
        }
      }

      try {
        const { error } = await supabase.from('sales').insert([
          {
            id: saleData.id,
            total: saleData.total,
            sale_type: saleData.saleType,
            cashier_id: saleData.cashierId,
            cashier_email: saleData.cashierEmail,
            attendant_id: saleData.attendantId,
            attendant_email: saleData.attendantEmail,
            customer_name: saleData.customerName,
            customer_phone: saleData.customerPhone,
            customer_id: saleData.customerId,
            amount_paid: saleData.amountPaid,
            customer_balance_before: saleData.customerBalanceBefore,
            customer_balance_after: saleData.customerBalanceAfter,
            items: saleData.items,
            payment_method: saleData.paymentMethod,
            ticket_id: saleData.ticketId,
            created_at: saleData.createdAt
          }
        ]);
        if (!error) await db.sales.update(saleId, { synced: 1 });
      } catch (err) {
        console.warn('Cloud sale insert postponed:', err.message);
      }

      try {
        const { error } = await supabase
          .from('tickets')
          .update({
            status: 'PAID',
            cashier_id: actor?.id,
            cashier_email: actor?.email,
            payment_method: paymentBreakdown,
            sale_id: saleId,
            paid_at: paidAt
          })
          .eq('id', ticket.id);
        if (!error) await db.tickets.update(ticket.id, { synced: 1 });
      } catch (err) {
        console.warn('Cloud ticket approval postponed:', err.message);
      }
    }

    await logAuditEvent({
      actorEmail: actor?.email,
      actorRole: actor?.role,
      action: 'ticket_approved',
      targetType: 'ticket',
      targetId: ticket.id,
      details: { saleId, total: ticket.total, paymentBreakdown }
    });

    return { success: true, sale: saleData };
  } catch (err) {
    console.warn('Unable to approve ticket:', err.message);
    return { success: false, reason: err.message };
  }
}

// ============================================================
// ADMIN-MANAGED BANK OPTIONS
// The list a cashier picks from when recording a bank transfer.
// ============================================================
export async function fetchBankOptions() {
  try {
    const { data, error } = await supabase.from('bank_options').select('*');
    if (error) throw error;
    if (!data) return;

    const pendingIds = new Set(
      (await db.bankOptions.where('synced').equals(0).toArray()).map((b) =>
        String(b.id)
      )
    );

    const mapped = data
      .filter((b) => !pendingIds.has(String(b.id)))
      .map((b) => ({
        id: String(b.id),
        name: b.name,
        active: b.active !== false,
        color: b.color || null,
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.bankOptions.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch bank options:', err.message);
  }
}

// `color` is optional — an administrator can set it (or change it later
// with updateBankOption) so a bank reads consistently everywhere it's
// picked from (OPAY green, Moniepoint light blue, etc.), but nothing
// forces a particular color; a bank with none just falls back to a
// neutral default chip in the UI.
export async function addBankOption(name, actor, color) {
  const bankOption = {
    id: generateId('BANK'),
    name: name.trim(),
    active: true,
    color: color || null,
    synced: 0
  };

  await db.bankOptions.add(bankOption);

  if (navigator.onLine) {
    try {
      const { error } = await supabase.from('bank_options').insert([
        { id: bankOption.id, name: bankOption.name, active: true, color: bankOption.color }
      ]);
      if (!error) await db.bankOptions.update(bankOption.id, { synced: 1 });
    } catch (err) {
      console.warn('Cloud bank option create postponed:', err.message);
    }
  }

  await logAuditEvent({
    actorEmail: actor?.email,
    actorRole: actor?.role,
    action: 'bank_option_added',
    targetType: 'bank_option',
    targetId: bankOption.id,
    details: { name: bankOption.name }
  });

  return bankOption;
}

export async function updateBankOption(id, changes, actor) {
  const payload = {};
  if (changes.name !== undefined) payload.name = changes.name.trim();
  if (changes.color !== undefined) payload.color = changes.color || null;

  await db.bankOptions.update(id, { ...payload, synced: 0 });

  if (navigator.onLine) {
    try {
      const { error } = await supabase.from('bank_options').update(payload).eq('id', id);
      if (!error) await db.bankOptions.update(id, { synced: 1 });
    } catch (err) {
      console.warn('Cloud bank option update postponed:', err.message);
    }
  }

  await logAuditEvent({
    actorEmail: actor?.email,
    actorRole: actor?.role,
    action: 'bank_option_updated',
    targetType: 'bank_option',
    targetId: id,
    details: payload
  });
}

export async function removeBankOption(id, actor) {
  // Soft-disable rather than delete, so past tickets/sales that
  // recorded a transfer against this bank keep a readable name instead
  // of a dangling reference.
  await db.bankOptions.update(id, { active: false, synced: 0 });

  if (navigator.onLine) {
    try {
      const { error } = await supabase
        .from('bank_options')
        .update({ active: false })
        .eq('id', id);
      if (!error) await db.bankOptions.update(id, { synced: 1 });
    } catch (err) {
      console.warn('Cloud bank option removal postponed:', err.message);
    }
  }

  await logAuditEvent({
    actorEmail: actor?.email,
    actorRole: actor?.role,
    action: 'bank_option_removed',
    targetType: 'bank_option',
    targetId: id
  });
}

export async function syncPendingBankOptionsToCloud() {
  try {
    const pending = await db.bankOptions.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const option of pending) {
      const { error } = await supabase.from('bank_options').upsert([
        { id: option.id, name: option.name, active: option.active, color: option.color || null }
      ]);
      if (!error) {
        await db.bankOptions.update(option.id, { synced: 1 });
      }
    }
  } catch (err) {
    console.warn('Unable to sync pending bank options:', err.message);
  }
}

// ============================================================
// AUDIT LOG: CROSS-DEVICE SYNC (administrator feature)
// Previously the Admin Audit Log only ever showed entries created on
// THIS device (useLiveQuery read straight from local Dexie, with
// nothing pulling other devices' entries down). This pulls every audit
// log entry from the last year down from Supabase, so any
// administrator can see what every manager AND every other
// administrator has done, regardless of which device they used.
// ============================================================
export async function fetchCloudAuditLog() {
  try {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

    let allEntries = [];
    let from = 0;
    const PAGE_SIZE = 1000;

    while (true) {
      const { data: page, error } = await supabase
        .from('audit_log')
        .select('*')
        .gte('created_at', oneYearAgo.toISOString())
        .order('created_at', { ascending: false })
        .range(from, from + PAGE_SIZE - 1);

      if (error) throw error;
      if (!page || page.length === 0) break;

      allEntries = allEntries.concat(page);

      if (page.length < PAGE_SIZE) break;
      from += PAGE_SIZE;
    }

    if (allEntries.length === 0) return;

    const pendingIds = new Set(
      (await db.auditLog.where('synced').equals(0).toArray()).map((e) =>
        String(e.id)
      )
    );

    const mapped = allEntries
      .filter((e) => !pendingIds.has(String(e.id)))
      .map((e) => ({
        id: String(e.id),
        actorEmail: e.actor_email,
        actorRole: e.actor_role,
        action: e.action,
        targetType: e.target_type || '',
        targetId: e.target_id || '',
        details: e.details ? JSON.stringify(e.details) : '',
        createdAt: e.created_at,
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.auditLog.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch audit log from cloud:', err.message);
  }
}