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
        .map((drug) => ({
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
          deletedAt: drug.deleted_at || drug.deletedAt || null,
          deletedBy: drug.deleted_by || drug.deletedBy || null,
          synced: 1
        }));

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
      const { error } = await supabase.from('drugs').upsert([
        {
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
          recommended_purchase_qty: drug.recommendedPurchaseQty ?? null
        }
      ]);

      if (!error) {
        await db.drugs.update(drug.id, { synced: 1 });
      }
    }
  } catch (err) {
    console.warn('Unable to sync pending drugs:', err.message);
  }
}

export async function syncPendingSalesToCloud() {
  try {
    const unsyncedSales = await db.sales.where('synced').equals(0).toArray();
    if (unsyncedSales.length === 0) return;

    for (const sale of unsyncedSales) {
      const { error } = await supabase.from('sales').insert([
        {
          id: sale.id,
          total: sale.total,
          sale_type: sale.saleType,
          cashier_id: sale.cashierId,
          cashier_email: sale.cashierEmail,
          customer_name: sale.customerName,
          customer_phone: sale.customerPhone,
          items: sale.items,
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
        recommended_purchase_qty: changes.recommendedPurchaseQty ?? null
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
              recommended_purchase_qty: c.recommendedPurchaseQty ?? null
            })
            .eq('id', target.drugId);
          if (!error) await db.drugs.update(target.drugId, { synced: 1 });
        } catch (err) {
          console.warn('Cloud drug edit (approved) postponed:', err.message);
        }
      }
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
            await supabase
              .from('drugs')
              .update({ stock: restoredStock })
              .eq('id', drugKey);
            await db.drugs.update(existingDrug.id, { synced: 1 });
          } catch (err) {
            console.warn('Cloud stock restore postponed:', err.message);
          }
        }
      }
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
      cloudSynced
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
        }
        resolvedItems.push(item);
      } else {
        resolvedItems.push(item);
      }
    }
  });

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

export async function createTicket(ticketPayload, actor) {
  // Same ₦0-ticket guard as App.jsx, duplicated here so a bug anywhere
  // else that calls this directly can't slip a free "sale" through.
  if (!ticketPayload.total || ticketPayload.total <= 0) {
    return {
      success: false,
      reason: `This ticket's total (₦${ticketPayload.total || 0}) can't be submitted — check item pricing first.`
    };
  }

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

  if (navigator.onLine) {
    try {
      const { error } = await supabase.from('tickets').insert([
        {
          id: ticket.id,
          status: ticket.status,
          items: ticket.items,
          total: ticket.total,
          sale_type: ticket.saleType,
          customer_name: ticket.customerName,
          customer_phone: ticket.customerPhone,
          attendant_id: ticket.attendantId,
          attendant_email: ticket.attendantEmail,
          daily_number: ticket.dailyNumber,
          created_at: ticket.createdAt
        }
      ]);
      if (!error) {
        await db.tickets.update(ticket.id, { synced: 1 });
      }
    } catch (err) {
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

  return { success: true, ticket };
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
    if (!data || data.length === 0) return;

    const pendingIds = new Set(
      (await db.tickets.where('synced').equals(0).toArray()).map((t) =>
        String(t.id)
      )
    );

    const mapped = data
      .filter((t) => !pendingIds.has(String(t.id)))
      .map((t) => ({
        id: String(t.id),
        status: t.status,
        items: t.items || [],
        total: Number(t.total || 0),
        saleType: t.sale_type || 'retail',
        customerName: t.customer_name || '',
        customerPhone: t.customer_phone || '',
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
      }));

    if (mapped.length > 0) {
      await db.tickets.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch tickets from cloud:', err.message);
  }
}

export async function syncPendingTicketsToCloud() {
  try {
    const pending = await db.tickets.where('synced').equals(0).toArray();
    if (pending.length === 0) return;

    for (const ticket of pending) {
      const { error } = await supabase.from('tickets').upsert([
        {
          id: ticket.id,
          status: ticket.status,
          items: ticket.items,
          total: ticket.total,
          sale_type: ticket.saleType,
          customer_name: ticket.customerName,
          customer_phone: ticket.customerPhone,
          daily_number: ticket.dailyNumber ?? null,
          adjustment_reason: ticket.adjustmentReason ?? null,
          sent_back_at: ticket.sentBackAt ?? null,
          attendant_id: ticket.attendantId,
          attendant_email: ticket.attendantEmail,
          cashier_id: ticket.cashierId || null,
          cashier_email: ticket.cashierEmail || null,
          payment_method: ticket.paymentMethod || null,
          sale_id: ticket.saleId || null,
          created_at: ticket.createdAt,
          paid_at: ticket.paidAt || null
        }
      ]);

      if (!error) {
        await db.tickets.update(ticket.id, { synced: 1 });
      }
    }
  } catch (err) {
    console.warn('Unable to sync pending tickets:', err.message);
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
          const { error } = await supabase
            .from('tickets')
            .update({ status: 'EXPIRED' })
            .eq('id', ticket.id);
          if (!error) {
            await db.tickets.update(ticket.id, { synced: 1 });
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
    await db.tickets.update(ticket.id, { status: 'CANCELLED', synced: 0 });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('tickets')
          .update({ status: 'CANCELLED' })
          .eq('id', ticket.id);
        if (!error) {
          await db.tickets.update(ticket.id, { synced: 1 });
        }
      } catch (err) {
        console.warn('Cloud ticket cancel postponed:', err.message);
      }
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

    await db.tickets.update(ticket.id, {
      status: 'SENT_BACK',
      adjustmentReason: trimmedReason,
      sentBackAt,
      synced: 0
    });

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('tickets')
          .update({
            status: 'SENT_BACK',
            adjustment_reason: trimmedReason,
            sent_back_at: sentBackAt
          })
          .eq('id', ticket.id)
          .eq('status', 'PENDING_PAYMENT');
        if (!error) {
          await db.tickets.update(ticket.id, { synced: 1 });
        }
      } catch (err) {
        console.warn('Cloud ticket send-back postponed:', err.message);
      }
    }

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

    const update = {
      items: updatedPayload.items,
      total: updatedPayload.total,
      saleType: updatedPayload.saleType,
      customerName: updatedPayload.customerName,
      customerPhone: updatedPayload.customerPhone,
      status: 'PENDING_PAYMENT',
      adjustmentReason: null,
      sentBackAt: null,
      synced: 0
    };

    await db.tickets.update(ticketId, update);

    if (navigator.onLine) {
      try {
        const { error } = await supabase
          .from('tickets')
          .update({
            items: update.items,
            total: update.total,
            sale_type: update.saleType,
            customer_name: update.customerName,
            customer_phone: update.customerPhone,
            status: 'PENDING_PAYMENT',
            adjustment_reason: null,
            sent_back_at: null
          })
          .eq('id', ticketId);
        if (!error) {
          await db.tickets.update(ticketId, { synced: 1 });
        }
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

    // Guard #2 (different devices/accounts): the actual fix for two
    // cashiers approving the same ticket at the same time. This
    // conditional update only succeeds for whichever device gets here
    // first — `.eq('status', 'PENDING_PAYMENT')` means the row only
    // matches (and `claimed` comes back non-empty) if nobody else has
    // already flipped it to PAID/CANCELLED/EXPIRED. Losing this race
    // means someone else got there first; bail out instead of
    // double-deducting stock and creating two sales for one ticket.
    if (navigator.onLine) {
      try {
        const { data: claimed, error: claimError } = await supabase
          .from('tickets')
          .update({
            status: 'PAID',
            cashier_id: actor?.id,
            cashier_email: actor?.email
          })
          .eq('id', ticket.id)
          .eq('status', 'PENDING_PAYMENT')
          .select();

        if (claimError) throw claimError;

        if (!claimed || claimed.length === 0) {
          // Someone else already claimed it — pull the real state down
          // so this device's queue updates and stops offering it.
          await fetchCloudTickets();
          return {
            success: false,
            reason:
              'This ticket was already approved (or cancelled) by someone else.'
          };
        }
      } catch (err) {
        // Couldn't even reach Supabase to check — fall through to the
        // offline path below. Two different OFFLINE devices approving
        // the same ticket at the same time is a real remaining edge
        // case (true conflict-free offline sync would need more than
        // this), but this still protects the common case: anyone
        // online, and the same device twice.
        console.warn('Ticket claim check failed, proceeding offline-style:', err.message);
      }
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
      items: ticket.items,
      paymentMethod: paymentBreakdown,
      ticketId: ticket.id,
      createdAt: paidAt,
      synced: 0
    };

    await db.transaction('rw', db.drugs, db.sales, db.tickets, async () => {
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
          await db.drugs.update(existingDrug.id, {
            stock: Math.max(0, (existingDrug.stock || 0) - item.quantity),
            synced: 0
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
    });

    if (navigator.onLine) {
      // Push the stock changes, the new sale, and the ticket update to
      // the cloud. Each piece retries independently on the next
      // reconnect (via syncPendingDrugsToCloud / syncPendingSalesToCloud
      // / syncPendingTicketsToCloud) if any of these calls fail here.
      for (const item of ticket.items) {
        if (!item.id) continue;
        const drugKey = String(item.id);
        const existingDrug =
          (await db.drugs.get(drugKey)) || (await db.drugs.get(Number(item.id)));
        if (existingDrug) {
          try {
            const { error } = await supabase
              .from('drugs')
              .update({ stock: existingDrug.stock })
              .eq('id', drugKey);
            if (!error) await db.drugs.update(existingDrug.id, { synced: 1 });
          } catch (err) {
            console.warn('Cloud stock update postponed:', err.message);
          }
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
        synced: 1
      }));

    if (mapped.length > 0) {
      await db.bankOptions.bulkPut(mapped);
    }
  } catch (err) {
    console.warn('Unable to fetch bank options:', err.message);
  }
}

export async function addBankOption(name, actor) {
  const bankOption = {
    id: generateId('BANK'),
    name: name.trim(),
    active: true,
    synced: 0
  };

  await db.bankOptions.add(bankOption);

  if (navigator.onLine) {
    try {
      const { error } = await supabase.from('bank_options').insert([
        { id: bankOption.id, name: bankOption.name, active: true }
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
        { id: option.id, name: option.name, active: option.active }
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