'use strict';
// diagnose-apply.js — run once after Docker is up to:
// 1. Show which offers are eligible for auto-apply
// 2. Show all pending apply tasks (stuck / queued / needs_info)
// 3. With --clean: cancel stuck tasks and strip auto-apply markers from offers
// 4. With --queue <offerRef>: queue an apply task (requires auto-apply unfrozen)
// Usage: node diagnose-apply.js [--queue <offerRef>] [--clean]
const api = require('./api_client.js');
const { isAutoApplyEnabled } = require('./auto-apply-flow.js');

const args = process.argv.slice(2);
const doQueue = args.includes('--queue') ? args[args.indexOf('--queue') + 1] : null;
const doClean = args.includes('--clean');

async function main() {
  console.log('=== JobCenter Apply Diagnostics ===\n');

  // 1. Profile check
  try {
    const p = await api.getProfile();
    console.log('Profile:', p.name || '(no name)', '|', p.email || '(no email)', '|', p.phone || '(no phone)');
    if (!p.name || !p.email || !p.phone) {
      console.error('\n⚠️  Profile is incomplete — apply tasks will fail with needs_info.');
      console.error('   Fix in the app Settings → Profil screen.\n');
    }
  } catch (e) { console.error('Profile unavailable:', e.message); }

  // 2. Docs check
  try {
    const docs = await api.listDocs();
    const cv = docs.filter((d) => d.id && d.id.startsWith('cv-'));
    const lettre = docs.filter((d) => d.id && d.id.startsWith('lettre-'));
    console.log(`\nDocuments: ${docs.length} total — ${cv.length} CVs, ${lettre.length} lettres`);
    if (docs.length) {
      console.log('  Latest docs:', docs.slice(0, 5).map((d) => d.id).join(', '));
    }
  } catch (e) { console.error('Docs unavailable:', e.message); }

  // 3. Eligible offers
  try {
    const all = await api.listOffers({ limit: 500 });
    const eligible = all.filter((o) => {
      const action = String(o.action || '').toLowerCase();
      return action === 'auto_apply' || action === 'autopostule';
    });
    const readyToApply = eligible.filter((o) => o.status === 'new' || o.status === 'applied');
    console.log(`\nOffers: ${all.length} total — ${eligible.length} marked auto_apply — ${readyToApply.length} ready to apply`);
    if (readyToApply.length) {
      console.log('\nEligible offers:');
      for (const o of readyToApply.slice(0, 10)) {
        console.log(`  [${o.ref || o.id}] ${(o.title || '').slice(0, 60)} — ${o.status} — ${o.link ? new URL(o.link).hostname : '?'}`);
      }
    } else {
      console.log('\n⚠️  No offers with action=auto_apply found.');
      console.log('   Auto-apply is frozen: the app now opens a manual apply sheet instead.');
      const newOffers = all.filter((o) => o.status === 'new').slice(0, 5);
      if (newOffers.length) {
        console.log('\n  Recent "new" offers:');
        for (const o of newOffers) {
          console.log(`    [${o.ref || o.id}] ${(o.title || '').slice(0, 60)} — ${o.link ? new URL(o.link).hostname : '?'}`);
        }
      }
    }

    // --clean also strips the marker that used to arm the apply pipeline.
    if (doClean && eligible.length) {
      console.log(`\nCleaning auto-apply markers from ${eligible.length} offer(s)…`);
      let cleared = 0;
      for (const o of eligible) {
        try {
          await api.updateOffer(o.id, { action: '' });
          cleared++;
        } catch (e) {
          console.log(`  ❌ Failed to clear ${o.id}: ${e.message}`);
        }
      }
      console.log(`  ✅ Cleared ${cleared}/${eligible.length} offer markers`);
    }
  } catch (e) { console.error('Offers unavailable:', e.message); }

  // 4. Apply tasks
  try {
    const allTasks = await api.listTasks({ limit: 50 });
    const applyTasks = allTasks.filter((t) => t.kind === 'apply');
    console.log(`\nApply tasks (${applyTasks.length}):`);
    for (const t of applyTasks.slice(0, 15)) {
      const age = t.updated_at ? Math.round((Date.now() - new Date(t.updated_at)) / 60000) + 'min' : '?';
      console.log(`  [${t.id}] ${t.status} — ${(t.request || t.offerRef || '').slice(0, 50)} — age: ${age}`);
      if (t.result) console.log(`    result: ${String(t.result).slice(0, 100)}`);
      if (t.needs && t.needs.length) console.log(`    needs: ${t.needs.slice(0, 2).join(' | ')}`);
    }

    if (doClean) {
      // Cancel every non-terminal apply task. `queued` matters most: those would
      // fire the moment auto-apply is re-enabled.
      // Fetch per live status rather than paging the whole table — /api/tasks is
      // ordered by updated_at DESC and capped at 500 rows.
      const terminal = ['done', 'failed', 'cancelled', 'skipped'];
      const live = ['queued', 'in_progress', 'needs_info', 'awaiting_confirm', 'confirmed'];
      const stuck = [];
      for (const st of live) {
        try {
          const batch = await api.listTasks({ status: st, limit: 500 });
          stuck.push(...batch.filter((t) => t.kind === 'apply'));
        } catch (e) { console.log(`  ❌ Failed to list ${st}:`, e.message); }
      }
      let done = 0;
      for (const t of stuck) {
        try {
          await api.updateTask(t.id, { status: 'cancelled', cancelledAt: new Date().toISOString(), result: 'Cleaned up by diagnose-apply --clean (auto-apply frozen)' });
          console.log(`  ✅ Cancelled ${t.status} task ${t.id}`);
          done++;
        } catch (e) { console.log(`  ❌ Failed to cancel ${t.id}:`, e.message); }
      }
      if (!stuck.length) console.log('  (no live apply tasks to cancel)');
      else console.log(`  → cancelled ${done}/${stuck.length} live apply tasks`);
    }
  } catch (e) { console.error('Tasks unavailable:', e.message); }

  // 5. Queue a specific offer if requested. Gated: auto-apply is frozen, and
  // the marker below is exactly what used to arm the pipeline.
  if (doQueue) {
    if (!isAutoApplyEnabled()) {
      console.log('\n🔒 Auto-apply is frozen — --queue refused.');
      console.log('   Set AUTO_APPLY=1 (or auto-postule.config.json enabled=true) to re-enable deliberately.');
    } else {
      try {
        let offer = null;
        try { offer = await api.getOffer(doQueue); } catch (_) {}
        if (!offer) {
          const all = await api.listOffers({ limit: 1000 });
          offer = all.find((o) => o.ref === doQueue || o.id === doQueue);
        }
        if (!offer) { console.error(`\n❌ Offer not found: ${doQueue}`); return; }
        await api.updateOffer(offer.id, { action: 'auto_apply' });
        const t = await api.createTask({
          kind: 'apply',
          action: 'auto_apply',
          request: 'auto_apply ' + (offer.ref || offer.id),
          status: 'queued',
          offerRef: offer.ref || offer.id,
          createdAt: new Date().toISOString(),
        });
        console.log(`\n✅ Auto-apply task queued for "${offer.title || doQueue}" → task ${t.id}`);
        console.log('   The apply-worker will pick it up within 10 seconds.');
      } catch (e) { console.error('\n❌ Queue failed:', e.message); }
    }
  }

  console.log('\n=== Done ===');
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
