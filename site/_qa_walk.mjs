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
assert(src.includes('ACTION.MULTI_AGAIN'), 'MULTI_AGAIN action');
assert(src.includes('PHASE.MULTI'), 'MULTI phase');
assert(src.includes('wallet_sendCalls'), 'EIP-5792 sendCalls');
assert(src.includes('wallet_getCapabilities'), 'EIP-5792 getCapabilities');
assert(src.includes('MULTI_MAX_BATCH'), 'batch cap');
assert(src.includes('runSequentialMultiApprovals'), 'pipelined sequential helper');
assert(src.includes('isWalletPendingOverlapError'), 'overlap fallback detect');
assert(src.includes('settleMultiCardFromHash'), 'async receipt → card');
assert(src.includes('Confirm ticket') || src.includes('showSequentialSigningBanner'), 'sequential progress copy');
assert(src.includes('function startMultiScratch'), 'startMultiScratch');
assert(src.includes('function pollMultiBoard'), 'pollMultiBoard');
assert(src.includes('scrollToStageTop'), 'scroll to stage after scratch again');
assert(src.includes('scrollToHeroTop'), 'scroll to hero on done');
assert(src.includes('function scrollWindowToElement'), 'single deterministic window scroll helper');
assert(!/scrollToHeroTop[\s\S]{0,120}scrollIntoView/.test(src), 'done scroll does not use scrollIntoView');
assert(!/\.focus\(\)/.test(src.slice(src.indexOf('function dispatchMultiOpen'), src.indexOf('function dispatchMultiClosePicker'))), 'picker focus cannot scroll the viewport');
assert(!src.includes('playModeDemo'), 'no demo mode toggle wiring');

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
assert(html.includes('One approval per ticket'), 'sequential mode copy');
assert(html.includes('id="multiBoard"'), 'multiBoard element');
assert(html.includes('id="multiEntry"'), 'multiEntry element');
assert(html.includes('id="multiSeqBanner"'), 'multiSeqBanner element');
assert(html.includes('id="scratchOneBtn"'), 'Scratch button');
assert(html.includes('id="scratchMaxBtn"'), 'Scratch max button');
assert(html.includes('id="scratchXBtn"'), 'Scratch X button');
assert(html.includes('id="multiAgainBtn"'), 'Scratch again button');
assert(/\.tiers\{[^}]*flex-wrap:nowrap/.test(html), 'tier tabs stay on one row');
assert(/\.tier-tab\{[^}]*min-width:0/.test(html), 'tier tabs can shrink below content width');
assert(!/\.tiers\{[^}]*width:max-content/.test(html), 'tier row no longer sized to content');
assert(/overflow-anchor:none/.test(html), 'stage opts out of scroll anchoring');
assert(html.includes('up to') && html.includes('per batch'), 'cap explained inline');
assert(!html.includes('playModeDemo'), 'no Try the demo button');
assert(!html.includes('Try the demo'), 'no Try the demo copy');
assert(/app\.js\?v=/.test(html), 'cache-busted app.js reference');
assert(html.includes('id="stageFooter"'), 'stageFooter element');
assert(!html.includes('Next ticket in'), 'HTML has no Next ticket in placeholder');
assert(!/Banked/i.test(html) || !/walletBanked/.test(html), 'HTML has no banked row id');
assert(!html.includes('walletBanked'), 'HTML no walletBanked');

/* v1 legacy withdraw — in-app wallet safety */
assert(src.includes('ensureLiveWalletForWrite'), 'live EIP-6963/injected wallet rebuild');
assert(src.includes('readV1StakedLive'), 'v1 balance read live at click/send');
assert(src.includes('ABI_STAKING_V1'), 'v1 staking ABI present');
assert(src.includes('cancelV1LegacyWithdraw'), 'in-panel cancel for v1 withdraw');
assert(html.includes('id="v1LegacyCancelBtn"'), 'v1 cancel button in HTML');
assert(html.includes('app.js?v=v2-live-8') || /app\.js\?v=v2-live-8/.test(html), 'asset version bumped');
assert(src.includes("ASSET_VERSION = 'v2-live-8'"), 'ASSET_VERSION matches index.html');
assert(!/your share of <b>65%<\/b>/.test(src), 'no hardcoded 65% emissions share');
assert(src.includes('Accrual starts at'), 'minStake accrual framing');
assert(src.includes('Pro-rata share of ~2,000 tickets/day'), 'honest emission copy');
{
  const fnStart = src.indexOf('async function doV1LegacyWithdrawAll');
  const fnEnd = src.indexOf('function cancelV1LegacyWithdraw', fnStart);
  assert(fnStart > 0 && fnEnd > fnStart, 'doV1LegacyWithdrawAll bounded');
  const body = src.slice(fnStart, fnEnd);
  assert(!/\bconfirm\s*\(/.test(body), 'v1 withdraw does not use window.confirm');
  assert(body.includes('ensureLiveWalletForWrite'), 'v1 withdraw rebuilds live wallet');
  assert(body.includes('readV1StakedLive'), 'v1 withdraw re-reads balance');
  assert(body.includes('formatSiteWriteError'), 'v1 withdraw surfaces formatted errors');
  assert(body.includes('ABI_STAKING_V1'), 'v1 withdraw uses v1 ABI');
  assert(body.includes('functionName: \'withdraw\''), 'v1 withdraw calls withdraw');
}

console.log(process.exitCode ? '\nMatrix walk: FAIL' : '\nMatrix walk: PASS');
