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

// ============================================================
// ROLE HIERARCHY
// administrator > manager > salesperson. A higher role can do
// everything a lower role can, plus its own extra features.
// ============================================================
export const ROLE_RANK = {
  salesperson: 0,
  manager: 1,
  administrator: 2
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

ensureSeedData();

export async function syncDrugsFromCloud() {
  try {
    const { data: cloudDrugs, error } = await supabase.from('drugs').select('*');
    if (error) throw error;

    if (cloudDrugs && cloudDrugs.length > 0) {
      const mappedDrugs = cloudDrugs.map((drug) => ({
        id: String(drug.id),
        name: drug.name,
        unitType: drug.unit_type || drug.unitType || 'Sachet',
        costPrice: Number(drug.cost_price ?? drug.costPrice ?? 0),
        retailPrice: Number(drug.retail_price ?? drug.retailPrice ?? 0),
        wholesalePrice: Number(drug.wholesale_price ?? drug.wholesalePrice ?? 0),
        stock: Number(drug.stock ?? 0),
        barcode: drug.barcode || '',
        deletedAt: drug.deleted_at || drug.deletedAt || null,
        deletedBy: drug.deleted_by || drug.deletedBy || null
      }));

      await db.drugs.bulkPut(mappedDrugs);
    }
  } catch (err) {
    console.warn('Unable to sync drugs from cloud:', err.message);
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