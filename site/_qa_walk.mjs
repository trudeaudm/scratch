/**
 * Offline walk of sessionDispatch guards (no wallet).
 * Run: node site/_qa_walk.mjs
 */
import fs from 'fs';

const src = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

assert(src.includes('ASSET_VERSION'), 'ASSET_VERSION defined');
assert(src.includes('async function sessionDispatch'), 'sessionDispatch exists');
assert(src.includes('ACTION.SELECT_TIER'), 'SELECT_TIER action');
assert(src.includes('ACTION.QUICK_SCRATCH'), 'QUICK_SCRATCH action');
assert(src.includes('ACTION.PICK_CARD'), 'PICK_CARD action');
assert(src.includes('ACTION.SCRATCH_ANOTHER'), 'SCRATCH_ANOTHER action');
assert(src.includes('ACTION.DISCONNECT'), 'DISCONNECT action');
assert(src.includes('function renderStageFooter'), 'renderStageFooter truth table');
assert(src.includes('N tickets left on this tier') || src.includes('tickets left on this tier'), 'tickets-left copy');
assert(!src.includes('walletBanked'), 'no walletBanked');
assert(!src.includes('setNextTicketTimerVisible'), 'no legacy timer helper');
assert(!/Next ticket in\s*—/.test(src), 'no Next ticket in — placeholder string');
assert(src.includes("sessionPhase() !== PHASE.IDLE"), 'startLiveScratch IDLE-only guard');
assert(src.includes('sessionInFlight()'), 'in-flight helper for disabled controls');

assert(src.includes('ACTION.MULTI_START'), 'MULTI_START action');
assert(src.includes('PHASE.MULTI'), 'MULTI phase');
assert(src.includes('wallet_sendCalls'), 'EIP-5792 sendCalls');
assert(src.includes('wallet_getCapabilities'), 'EIP-5792 getCapabilities');
assert(src.includes('max 10 per batch') || src.includes('MULTI_MAX_BATCH'), 'batch cap');
assert(src.includes('runSequentialMultiApprovals'), 'pipelined sequential helper');
assert(src.includes('isWalletPendingOverlapError'), 'overlap fallback detect');
assert(src.includes('settleMultiCardFromHash'), 'async receipt → card');
assert(src.includes('Confirm ticket') || src.includes('showSequentialSigningBanner'), 'sequential progress copy');
assert(src.includes('one-by-one') || src.includes('One approval per ticket'), 'sequential mode copy');
assert(src.includes('function startMultiScratch'), 'startMultiScratch');
assert(src.includes('function pollMultiBoard'), 'pollMultiBoard');

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
assert(html.includes('id="multiBoard"'), 'multiBoard element');
assert(html.includes('id="multiEntry"'), 'multiEntry element');
assert(html.includes('id="multiSeqBanner"'), 'multiSeqBanner element');
assert(html.includes('max 10 per batch'), 'cap explained inline');
assert(/app\.js\?v=/.test(html), 'cache-busted app.js reference');
assert(html.includes('id="stageFooter"'), 'stageFooter element');
assert(!html.includes('Next ticket in'), 'HTML has no Next ticket in placeholder');
assert(!/Banked/i.test(html) || !/walletBanked/.test(html), 'HTML has no banked row id');
assert(!html.includes('walletBanked'), 'HTML no walletBanked');

console.log(process.exitCode ? '\nMatrix walk: FAIL' : '\nMatrix walk: PASS');
