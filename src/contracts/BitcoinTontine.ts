import {
    Address,
    Blockchain,
    BytesWriter,
    Calldata,
    NetEvent,
    OP_NET,
    Revert,
} from '@btc-vision/btc-runtime/runtime';
import { StoredMapU256 } from '@btc-vision/btc-runtime/runtime/storage/maps/StoredMapU256';
import { u256 } from '@btc-vision/as-bignum/assembly';

// =============================================================================
// CONSTANTS
// =============================================================================
const POOL_MAX_HISTORICAL:  u64 = 50;
const POOL_MIN_START:       u64 = 5;       // 10% of 50
const START_WAIT_BLOCKS:    u64 = 144;     // 24 hours
const INITIAL_INTERVAL:     u64 = 1008;   // 7 days in blocks
const MIN_INTERVAL:         u64 = 6;      // ~1 hour in blocks (1 Bitcoin block = 10min, 6 = 1h)
const DAILY_BLOCKS:         u64 = 144;    // blocks per day
const DAILY_REDUCTION:      u64 = 24;     // blocks reduced per day ( (1008-6)/42 days ≈ 24 )
const TOTAL_ACCEL_DAYS:     u64 = 42;     // days to reach min interval
const HUNT_THRESHOLD_PCT:   u64 = 70;     // % of acceleration before hunting opens
const HUNT_WINDOW_BLOCKS:   u64 = 1;      // 1 block window (~10 min on mainnet)
const POOL_BULLETS:         u64 = 3;      // total manual hunts per pool
const PROTOCOL_BPS:         u64 = 30;     // 0.3% = 30 basis points
const HUNTER_BPS:           u64 = 1000;   // 10%
const HUNTER_PENALTY_BPS:   u64 = 500;    // 5% penalty for failed hunt
const BPS_BASE:             u64 = 10000;

// =============================================================================
// STORAGE POINTERS (module level — CRITICAL)
// =============================================================================

// Pool data
const pHistoricalCount:  u16 = Blockchain.nextPointer; // poolId -> u64
const pActiveCount:      u16 = Blockchain.nextPointer; // poolId -> u64
const pPreStartCount:    u16 = Blockchain.nextPointer; // poolId -> u64 (players before start)
const pStartBlock:       u16 = Blockchain.nextPointer; // poolId -> u64 (when 5th joined)
const pGameStartBlock:   u16 = Blockchain.nextPointer; // poolId -> u64 (startBlock + 144)
const pStarted:          u16 = Blockchain.nextPointer; // poolId -> 0/1
const pBulletsLeft:      u16 = Blockchain.nextPointer; // poolId -> u64
const pTotalFunds:       u16 = Blockchain.nextPointer; // poolId -> u64
const pTokenContract:    u16 = Blockchain.nextPointer; // poolId -> address as u256
const pTotalPoints:      u16 = Blockchain.nextPointer; // poolId -> u64 (sum of all active points)

// Hunt state per pool
const pHuntActive:       u16 = Blockchain.nextPointer; // poolId -> 0/1
const pHuntHunter:       u16 = Blockchain.nextPointer; // poolId -> address as u256
const pHuntTarget:       u16 = Blockchain.nextPointer; // poolId -> address as u256
const pHuntStartBlock:   u16 = Blockchain.nextPointer; // poolId -> u64

// Player data (key = poolId<<32 | addressHash)
const ppActive:          u16 = Blockchain.nextPointer; // -> 0/1
const ppEntryBlock:      u16 = Blockchain.nextPointer; // -> u64
const ppLastPingBlock:   u16 = Blockchain.nextPointer; // -> u64
const ppPoints:          u16 = Blockchain.nextPointer; // -> u64 accumulated
const ppPointsUpdated:   u16 = Blockchain.nextPointer; // -> u64 block of last update
const ppHasUsedBullet:   u16 = Blockchain.nextPointer; // -> 0/1
const ppDeposit:         u16 = Blockchain.nextPointer; // -> u64

// Player list per pool (for distribution iteration)
const pPlayerList:       u16 = Blockchain.nextPointer; // (poolId, index) -> address as u256
const pPlayerIndex:      u16 = Blockchain.nextPointer; // (poolId, address) -> index+1 (0=not in list)

// Global
const gCurrentPoolId:    u16 = Blockchain.nextPointer; // -> u64

// =============================================================================
// EVENTS
// =============================================================================
class PoolCreatedEvent extends NetEvent {
    constructor(poolId: u64) {
        const w = new BytesWriter(8);
        w.writeU64(poolId);
        super('PoolCreated', w);
    }
}

class PlayerJoinedEvent extends NetEvent {
    constructor(poolId: u64, player: Address, historicalCount: u64) {
        const w = new BytesWriter(8 + 32 + 8);
        w.writeU64(poolId);
        w.writeAddress(player);
        w.writeU64(historicalCount);
        super('PlayerJoined', w);
    }
}

class GameStartedEvent extends NetEvent {
    constructor(poolId: u64, gameStartBlock: u64) {
        const w = new BytesWriter(16);
        w.writeU64(poolId);
        w.writeU64(gameStartBlock);
        super('GameStarted', w);
    }
}

class PlayerPingedEvent extends NetEvent {
    constructor(poolId: u64, player: Address, nextPingBlock: u64) {
        const w = new BytesWriter(8 + 32 + 8);
        w.writeU64(poolId);
        w.writeAddress(player);
        w.writeU64(nextPingBlock);
        super('PlayerPinged', w);
    }
}

class HuntDeclaredEvent extends NetEvent {
    constructor(poolId: u64, hunter: Address, target: Address, windowEnd: u64) {
        const w = new BytesWriter(8 + 32 + 32 + 8);
        w.writeU64(poolId);
        w.writeAddress(hunter);
        w.writeAddress(target);
        w.writeU64(windowEnd);
        super('HuntDeclared', w);
    }
}

class HuntSuccessEvent extends NetEvent {
    constructor(poolId: u64, hunter: Address, target: Address, reward: u64) {
        const w = new BytesWriter(8 + 32 + 32 + 8);
        w.writeU64(poolId);
        w.writeAddress(hunter);
        w.writeAddress(target);
        w.writeU64(reward);
        super('HuntSuccess', w);
    }
}

class HuntFailedEvent extends NetEvent {
    constructor(poolId: u64, hunter: Address, target: Address, penalty: u64) {
        const w = new BytesWriter(8 + 32 + 32 + 8);
        w.writeU64(poolId);
        w.writeAddress(hunter);
        w.writeAddress(target);
        w.writeU64(penalty);
        super('HuntFailed', w);
    }
}

class PlayerDiedEvent extends NetEvent {
    constructor(poolId: u64, player: Address, distributed: u64) {
        const w = new BytesWriter(8 + 32 + 8);
        w.writeU64(poolId);
        w.writeAddress(player);
        w.writeU64(distributed);
        super('PlayerDied', w);
    }
}

class GameWonEvent extends NetEvent {
    constructor(poolId: u64, winner: Address, prize: u64) {
        const w = new BytesWriter(8 + 32 + 8);
        w.writeU64(poolId);
        w.writeAddress(winner);
        w.writeU64(prize);
        super('GameWon', w);
    }
}

// =============================================================================
// KEY HELPERS
// =============================================================================
function poolKey(poolId: u64): u256 {
    return u256.fromU64(poolId);
}

function playerKey(poolId: u64, addr: Address): u256 {
    // Combine poolId (8 bytes) + first 24 bytes of address into u256
    const buf = new Uint8Array(32);
    // poolId in first 8 bytes
    buf[0] = u8((poolId >> 56) & 0xff);
    buf[1] = u8((poolId >> 48) & 0xff);
    buf[2] = u8((poolId >> 40) & 0xff);
    buf[3] = u8((poolId >> 32) & 0xff);
    buf[4] = u8((poolId >> 24) & 0xff);
    buf[5] = u8((poolId >> 16) & 0xff);
    buf[6] = u8((poolId >>  8) & 0xff);
    buf[7] = u8( poolId        & 0xff);
    // address in next 24 bytes
    const addrBytes = addr as Uint8Array;
    for (let i = 0; i < 24 && i < addrBytes.length; i++) {
        buf[8 + i] = addrBytes[i];
    }
    return u256.fromBytes(buf);
}

function playerListKey(poolId: u64, index: u64): u256 {
    const buf = new Uint8Array(32);
    buf[0] = u8((poolId >> 56) & 0xff);
    buf[1] = u8((poolId >> 48) & 0xff);
    buf[2] = u8((poolId >> 40) & 0xff);
    buf[3] = u8((poolId >> 32) & 0xff);
    buf[4] = u8((poolId >> 24) & 0xff);
    buf[5] = u8((poolId >> 16) & 0xff);
    buf[6] = u8((poolId >>  8) & 0xff);
    buf[7] = u8( poolId        & 0xff);
    buf[8] = u8((index >> 56) & 0xff);
    buf[9] = u8((index >> 48) & 0xff);
    buf[10]= u8((index >> 40) & 0xff);
    buf[11]= u8((index >> 32) & 0xff);
    buf[12]= u8((index >> 24) & 0xff);
    buf[13]= u8((index >> 16) & 0xff);
    buf[14]= u8((index >>  8) & 0xff);
    buf[15]= u8( index        & 0xff);
    return u256.fromBytes(buf);
}

function addrToU256(addr: Address): u256 {
    return u256.fromBytes(addr as Uint8Array);
}

function u256ToAddr(val: u256): Address {
    const bytes = val.toBytes();
    const addr  = new Uint8Array(32);
    for (let i = 0; i < 32; i++) addr[i] = bytes[i];
    return changetype<Address>(addr);
}

// =============================================================================
// INTERVAL CALCULATOR
// =============================================================================
function getCurrentInterval(gameStartBlock: u64, currentBlock: u64): u64 {
    if (currentBlock <= gameStartBlock) return INITIAL_INTERVAL;
    const elapsedDays = (currentBlock - gameStartBlock) / DAILY_BLOCKS;
    const reduction   = elapsedDays * DAILY_REDUCTION;
    if (reduction >= INITIAL_INTERVAL - MIN_INTERVAL) return MIN_INTERVAL;
    return INITIAL_INTERVAL - reduction;
}

function isHuntingOpen(gameStartBlock: u64, currentBlock: u64): bool {
    if (currentBlock <= gameStartBlock) return false;
    const elapsedDays    = (currentBlock - gameStartBlock) / DAILY_BLOCKS;
    const thresholdDays  = TOTAL_ACCEL_DAYS * HUNT_THRESHOLD_PCT / 100; // 42*70/100 = 29
    return elapsedDays >= thresholdDays;
}

// =============================================================================
// MAIN CONTRACT
// =============================================================================
export class BitcoinTontine extends OP_NET {

    // Pool maps
    private readonly _historicalCount: StoredMapU256;
    private readonly _activeCount:     StoredMapU256;
    private readonly _preStartCount:   StoredMapU256;
    private readonly _startBlock:      StoredMapU256;
    private readonly _gameStartBlock:  StoredMapU256;
    private readonly _started:         StoredMapU256;
    private readonly _bulletsLeft:     StoredMapU256;
    private readonly _totalFunds:      StoredMapU256;
    private readonly _tokenContract:   StoredMapU256;
    private readonly _totalPoints:     StoredMapU256;

    // Hunt maps
    private readonly _huntActive:      StoredMapU256;
    private readonly _huntHunter:      StoredMapU256;
    private readonly _huntTarget:      StoredMapU256;
    private readonly _huntStartBlock:  StoredMapU256;

    // Player maps
    private readonly _ppActive:        StoredMapU256;
    private readonly _ppEntryBlock:    StoredMapU256;
    private readonly _ppLastPing:      StoredMapU256;
    private readonly _ppPoints:        StoredMapU256;
    private readonly _ppPointsUpdated: StoredMapU256;
    private readonly _ppUsedBullet:    StoredMapU256;
    private readonly _ppDeposit:       StoredMapU256;

    // Player list
    private readonly _playerList:      StoredMapU256;
    private readonly _playerIndex:     StoredMapU256;

    // Global
    private readonly _currentPoolId:   StoredMapU256;

    public constructor() {
        super();
        this._historicalCount = new StoredMapU256(pHistoricalCount);
        this._activeCount     = new StoredMapU256(pActiveCount);
        this._preStartCount   = new StoredMapU256(pPreStartCount);
        this._startBlock      = new StoredMapU256(pStartBlock);
        this._gameStartBlock  = new StoredMapU256(pGameStartBlock);
        this._started         = new StoredMapU256(pStarted);
        this._bulletsLeft     = new StoredMapU256(pBulletsLeft);
        this._totalFunds      = new StoredMapU256(pTotalFunds);
        this._tokenContract   = new StoredMapU256(pTokenContract);
        this._totalPoints     = new StoredMapU256(pTotalPoints);
        this._huntActive      = new StoredMapU256(pHuntActive);
        this._huntHunter      = new StoredMapU256(pHuntHunter);
        this._huntTarget      = new StoredMapU256(pHuntTarget);
        this._huntStartBlock  = new StoredMapU256(pHuntStartBlock);
        this._ppActive        = new StoredMapU256(ppActive);
        this._ppEntryBlock    = new StoredMapU256(ppEntryBlock);
        this._ppLastPing      = new StoredMapU256(ppLastPingBlock);
        this._ppPoints        = new StoredMapU256(ppPoints);
        this._ppPointsUpdated = new StoredMapU256(ppPointsUpdated);
        this._ppUsedBullet    = new StoredMapU256(ppHasUsedBullet);
        this._ppDeposit       = new StoredMapU256(ppDeposit);
        this._playerList      = new StoredMapU256(pPlayerList);
        this._playerIndex     = new StoredMapU256(pPlayerIndex);
        this._currentPoolId   = new StoredMapU256(gCurrentPoolId);
    }

    public override onDeployment(_calldata: Calldata): void {
        // Initialize pool 0
        this._initPool(u64(0));
    }

    // =========================================================================
    // JOIN
    // join(tokenContract: Address)
    // =========================================================================
    @emit('PlayerJoined')
    public join(calldata: Calldata): BytesWriter {
        const tokenAddr = calldata.readAddress();
        const caller    = Blockchain.tx.sender;
        const poolId    = this._currentPoolId.get(u256.Zero).toU64();
        const pKey      = poolKey(poolId);

        // Check pool not full historically
        const historical = this._historicalCount.get(pKey).toU64();
        if (historical >= POOL_MAX_HISTORICAL) {
            throw new Revert('Pool is full');
        }

        // Check not already active in this pool
        const plKey = playerKey(poolId, caller);
        if (this._ppActive.get(plKey) == u256.One) {
            throw new Revert('Already in this pool');
        }

        // Pull 10 tokens from player
        const entryAmount = this._toBaseUnits(10);
        this._transferFrom(tokenAddr, caller, this.address, entryAmount);

        // Register player
        const block = Blockchain.block.number;
        this._ppActive.set(plKey, u256.One);
        this._ppEntryBlock.set(plKey, u256.fromU64(block));
        this._ppLastPing.set(plKey, u256.fromU64(block));
        this._ppPoints.set(plKey, u256.Zero);
        this._ppPointsUpdated.set(plKey, u256.fromU64(block));
        this._ppUsedBullet.set(plKey, u256.Zero);
        this._ppDeposit.set(plKey, u256.fromU64(entryAmount));

        // Add to player list
        const listIdx = this._activeCount.get(pKey).toU64();
        const listKey = playerListKey(poolId, listIdx);
        this._playerList.set(listKey, addrToU256(caller));
        this._playerIndex.set(plKey, u256.fromU64(listIdx + 1)); // +1 so 0 = not in list

        // Update pool counters
        const newHistorical = historical + 1;
        const newActive     = this._activeCount.get(pKey).toU64() + 1;
        this._historicalCount.set(pKey, u256.fromU64(newHistorical));
        this._activeCount.set(pKey, u256.fromU64(newActive));
        this._totalFunds.set(pKey, u256.fromU64(this._totalFunds.get(pKey).toU64() + entryAmount));

        // Store token contract if first player
        if (historical == 0) {
            this._tokenContract.set(pKey, addrToU256(tokenAddr));
            this._bulletsLeft.set(pKey, u256.fromU64(POOL_BULLETS));
        }

        // Check if game should start (5th player triggers 24h wait)
        const started = this._started.get(pKey) == u256.One;
        if (!started && newHistorical == POOL_MIN_START) {
            this._startBlock.set(pKey, u256.fromU64(block));
            const gameStart = block + START_WAIT_BLOCKS;
            this._gameStartBlock.set(pKey, u256.fromU64(gameStart));
            this._started.set(pKey, u256.One);
            this.emitEvent(new GameStartedEvent(poolId, gameStart));
        }

        this.emitEvent(new PlayerJoinedEvent(poolId, caller, newHistorical));

        const w = new BytesWriter(16);
        w.writeU64(poolId);
        w.writeU64(newHistorical);
        return w;
    }

    // =========================================================================
    // PING
    // ping(poolId: u64)
    // =========================================================================
    @emit('PlayerPinged')
    public ping(calldata: Calldata): BytesWriter {
        const poolId = calldata.readU64();
        const caller  = Blockchain.tx.sender;
        const block   = Blockchain.block.number;
        const pKey    = poolKey(poolId);
        const plKey   = playerKey(poolId, caller);

        this._requireActive(poolId, caller);
        this._requireGameStarted(poolId, block);

        // Update points before changing lastPing
        this._updatePoints(poolId, caller, block);

        // Check that ping is within valid window
        const lastPing    = this._ppLastPing.get(plKey).toU64();
        const gameStart   = this._gameStartBlock.get(pKey).toU64();
        const interval    = getCurrentInterval(gameStart, lastPing);
        const deadline    = lastPing + interval;

        if (block > deadline) {
            throw new Revert('Ping window expired — you are dead');
        }

        // If there's an active hunt targeting this player — counter-hunt triggered
        // The ping resolves in the player's favor (handled in resolveHunt)
        // Here we just update the ping
        this._ppLastPing.set(plKey, u256.fromU64(block));

        // Calculate next ping deadline with NEW interval
        const newInterval  = getCurrentInterval(gameStart, block);
        const nextDeadline = block + newInterval;

        this.emitEvent(new PlayerPingedEvent(poolId, caller, nextDeadline));

        const w = new BytesWriter(16);
        w.writeU64(nextDeadline);
        w.writeU64(newInterval);
        return w;
    }

    // =========================================================================
    // DECLARE HUNT
    // declareHunt(poolId: u64, target: Address)
    // =========================================================================
    @emit('HuntDeclared')
    public declareHunt(calldata: Calldata): BytesWriter {
        const poolId = calldata.readU64();
        const target  = calldata.readAddress();
        const caller  = Blockchain.tx.sender;
        const block   = Blockchain.block.number;
        const pKey    = poolKey(poolId);
        const plKey   = playerKey(poolId, caller);

        this._requireActive(poolId, caller);
        this._requireGameStarted(poolId, block);

        // Check hunting is open (70% threshold)
        const gameStart = this._gameStartBlock.get(pKey).toU64();
        if (!isHuntingOpen(gameStart, block)) {
            throw new Revert('Hunting not open yet');
        }

        // Check bullets available in pool
        if (this._bulletsLeft.get(pKey).toU64() == 0) {
            throw new Revert('No bullets left in pool');
        }

        // Check hunter hasn't used their bullet
        if (this._ppUsedBullet.get(plKey) == u256.One) {
            throw new Revert('You already used your bullet');
        }

        // Check target is active
        this._requireActive(poolId, target);

        // Check no hunt already active
        if (this._huntActive.get(pKey) == u256.One) {
            throw new Revert('A hunt is already in progress');
        }

        // Cannot hunt yourself
        if (caller == target) {
            throw new Revert('Cannot hunt yourself');
        }

        // Start hunt
        this._huntActive.set(pKey, u256.One);
        this._huntHunter.set(pKey, addrToU256(caller));
        this._huntTarget.set(pKey, addrToU256(target));
        this._huntStartBlock.set(pKey, u256.fromU64(block));

        const windowEnd = block + HUNT_WINDOW_BLOCKS;

        this.emitEvent(new HuntDeclaredEvent(poolId, caller, target, windowEnd));

        const w = new BytesWriter(8);
        w.writeU64(windowEnd);
        return w;
    }

    // =========================================================================
    // RESOLVE HUNT
    // resolveHunt(poolId: u64)
    // Called after hunt window expires
    // =========================================================================
    public resolveHunt(calldata: Calldata): BytesWriter {
        const poolId = calldata.readU64();
        const block   = Blockchain.block.number;
        const pKey    = poolKey(poolId);

        if (this._huntActive.get(pKey) != u256.One) {
            throw new Revert('No active hunt');
        }

        const huntStart = this._huntStartBlock.get(pKey).toU64();
        if (block <= huntStart + HUNT_WINDOW_BLOCKS) {
            throw new Revert('Hunt window still open');
        }

        const hunter     = u256ToAddr(this._huntHunter.get(pKey));
        const target     = u256ToAddr(this._huntTarget.get(pKey));
        const hunterKey  = playerKey(poolId, hunter);
        const targetKey  = playerKey(poolId, target);
        const tokenAddr  = u256ToAddr(this._tokenContract.get(pKey));

        // Did the target ping during the hunt window?
        const targetLastPing = this._ppLastPing.get(targetKey).toU64();
        const targetPingedDuringHunt = targetLastPing > huntStart;

        // Close hunt
        this._huntActive.set(pKey, u256.Zero);

        if (targetPingedDuringHunt) {
            // ── HUNT FAILED: target escaped ──
            // Hunter loses bullet and pays 5% penalty
            this._ppUsedBullet.set(hunterKey, u256.One);
            // Note: bullet NOT consumed from pool (hunter failed)

            const hunterDeposit = this._ppDeposit.get(hunterKey).toU64();
            const penalty       = (hunterDeposit * HUNTER_PENALTY_BPS) / BPS_BASE;

            // Deduct penalty from hunter deposit
            this._ppDeposit.set(hunterKey, u256.fromU64(hunterDeposit - penalty));

            // Add penalty to target deposit
            const targetDeposit = this._ppDeposit.get(targetKey).toU64();
            this._ppDeposit.set(targetKey, u256.fromU64(targetDeposit + penalty));

            this.emitEvent(new HuntFailedEvent(poolId, hunter, target, penalty));

            const w = new BytesWriter(1);
            w.writeBoolean(false); // hunt failed
            return w;

        } else {
            // ── HUNT SUCCESS: liquidate target ──
            this._ppUsedBullet.set(hunterKey, u256.One);

            // Consume one pool bullet
            const bulletsLeft = this._bulletsLeft.get(pKey).toU64();
            this._bulletsLeft.set(pKey, u256.fromU64(bulletsLeft - 1));

            // Liquidate target
            this._liquidatePlayer(poolId, target, hunter, tokenAddr, block, true);

            return this._checkWinner(poolId, tokenAddr);
        }
    }

    // =========================================================================
    // LIQUIDATE INACTIVE
    // liquidateInactive(poolId: u64, target: Address)
    // Anyone can call if target's ping window expired
    // =========================================================================
    public liquidateInactive(calldata: Calldata): BytesWriter {
        const poolId = calldata.readU64();
        const target  = calldata.readAddress();
        const block   = Blockchain.block.number;
        const pKey    = poolKey(poolId);
        const tKey    = playerKey(poolId, target);

        this._requireActive(poolId, target);
        this._requireGameStarted(poolId, block);

        // Verify target's window has expired
        const gameStart   = this._gameStartBlock.get(pKey).toU64();
        const lastPing    = this._ppLastPing.get(tKey).toU64();
        const interval    = getCurrentInterval(gameStart, lastPing);
        const deadline    = lastPing + interval;

        if (block <= deadline) {
            throw new Revert('Ping window has not expired');
        }

        // No manual hunt needed — liquidate directly, no 10% to caller
        const tokenAddr = u256ToAddr(this._tokenContract.get(pKey));
        this._liquidatePlayer(poolId, target, Address.dead(), tokenAddr, block, false);

        return this._checkWinner(poolId, tokenAddr);
    }

    // =========================================================================
    // CLAIM WIN
    // claimWin(poolId: u64)
    // =========================================================================
    @emit('GameWon')
    public claimWin(calldata: Calldata): BytesWriter {
        const poolId = calldata.readU64();
        const caller  = Blockchain.tx.sender;
        const pKey    = poolKey(poolId);

        this._requireActive(poolId, caller);

        if (this._activeCount.get(pKey).toU64() != 1) {
            throw new Revert('Game not over yet');
        }

        const prize      = this._totalFunds.get(pKey).toU64();
        const tokenAddr  = u256ToAddr(this._tokenContract.get(pKey));

        // Reset pool
        const plKey = playerKey(poolId, caller);
        this._ppActive.set(plKey, u256.Zero);
        this._activeCount.set(pKey, u256.Zero);
        this._totalFunds.set(pKey, u256.Zero);

        // Open new pool
        const newPoolId = poolId + 1;
        this._currentPoolId.set(u256.Zero, u256.fromU64(newPoolId));
        this._initPool(newPoolId);

        // Transfer prize to winner
        this._transfer(tokenAddr, caller, prize);

        this.emitEvent(new GameWonEvent(poolId, caller, prize));

        const w = new BytesWriter(8);
        w.writeU64(prize);
        return w;
    }

    // =========================================================================
    // READ METHODS
    // =========================================================================

    public getPoolInfo(calldata: Calldata): BytesWriter {
        const poolId     = calldata.readU64();
        const block      = Blockchain.block.number;
        const pKey       = poolKey(poolId);
        const historical = this._historicalCount.get(pKey).toU64();
        const active     = this._activeCount.get(pKey).toU64();
        const started    = this._started.get(pKey) == u256.One;
        const gameStart  = this._gameStartBlock.get(pKey).toU64();
        const bullets    = this._bulletsLeft.get(pKey).toU64();
        const funds      = this._totalFunds.get(pKey).toU64();
        const interval   = started ? getCurrentInterval(gameStart, block) : INITIAL_INTERVAL;
        const huntOpen   = started ? isHuntingOpen(gameStart, block) : false;
        const huntActive = this._huntActive.get(pKey) == u256.One;

        const w = new BytesWriter(8*8 + 1 + 1 + 1);
        w.writeU64(poolId);
        w.writeU64(historical);
        w.writeU64(active);
        w.writeU64(gameStart);
        w.writeU64(bullets);
        w.writeU64(funds);
        w.writeU64(interval);
        w.writeU64(block);
        w.writeBoolean(started);
        w.writeBoolean(huntOpen);
        w.writeBoolean(huntActive);
        return w;
    }

    public getPlayerInfo(calldata: Calldata): BytesWriter {
        const poolId   = calldata.readU64();
        const player   = calldata.readAddress();
        const block    = Blockchain.block.number;
        const pKey     = poolKey(poolId);
        const plKey    = playerKey(poolId, player);

        const active      = this._ppActive.get(plKey) == u256.One;
        const lastPing    = this._ppLastPing.get(plKey).toU64();
        const deposit     = this._ppDeposit.get(plKey).toU64();
        const points      = this._ppPoints.get(plKey).toU64();
        const usedBullet  = this._ppUsedBullet.get(plKey) == u256.One;

        const gameStart   = this._gameStartBlock.get(pKey).toU64();
        const interval    = getCurrentInterval(gameStart, lastPing);
        const deadline    = lastPing + interval;
        const blocksLeft  = block < deadline ? deadline - block : u64(0);
        const isExpired   = active && block > deadline;

        // Calculate current accumulated points (lazy)
        const storedPts   = this._ppPoints.get(plKey).toU64();
        const lastUpdated = this._ppPointsUpdated.get(plKey).toU64();
        const livePoints  = active ? storedPts + (block - lastUpdated) : storedPts;

        const nextInterval = getCurrentInterval(gameStart, block);
        const nextDeadline = block + nextInterval;

        const w = new BytesWriter(8*8 + 1 + 1);
        w.writeU64(blocksLeft);
        w.writeU64(deadline);
        w.writeU64(deposit);
        w.writeU64(livePoints);
        w.writeU64(lastPing);
        w.writeU64(nextDeadline);
        w.writeU64(nextInterval);
        w.writeU64(block);
        w.writeBoolean(active);
        w.writeBoolean(isExpired);
        w.writeBoolean(usedBullet);
        return w;
    }

    public getHuntInfo(calldata: Calldata): BytesWriter {
        const poolId    = calldata.readU64();
        const pKey      = poolKey(poolId);
        const active    = this._huntActive.get(pKey) == u256.One;
        const hunter    = u256ToAddr(this._huntHunter.get(pKey));
        const target    = u256ToAddr(this._huntTarget.get(pKey));
        const startBlk  = this._huntStartBlock.get(pKey).toU64();
        const windowEnd = startBlk + HUNT_WINDOW_BLOCKS;
        const block     = Blockchain.block.number;
        const expired   = active && block > windowEnd;

        const w = new BytesWriter(8 + 32 + 32 + 8 + 1 + 1);
        w.writeU64(startBlk);
        w.writeAddress(hunter);
        w.writeAddress(target);
        w.writeU64(windowEnd);
        w.writeBoolean(active);
        w.writeBoolean(expired);
        return w;
    }

    public getCurrentPoolId(_calldata: Calldata): BytesWriter {
        const poolId = this._currentPoolId.get(u256.Zero).toU64();
        const w = new BytesWriter(8);
        w.writeU64(poolId);
        return w;
    }

    // =========================================================================
    // PRIVATE HELPERS
    // =========================================================================

    private _initPool(poolId: u64): void {
        const pKey = poolKey(poolId);
        this._historicalCount.set(pKey, u256.Zero);
        this._activeCount.set(pKey, u256.Zero);
        this._bulletsLeft.set(pKey, u256.fromU64(POOL_BULLETS));
        this._totalFunds.set(pKey, u256.Zero);
        this._started.set(pKey, u256.Zero);
        this._huntActive.set(pKey, u256.Zero);
        this.emitEvent(new PoolCreatedEvent(poolId));
    }

    private _requireActive(poolId: u64, player: Address): void {
        const plKey = playerKey(poolId, player);
        if (this._ppActive.get(plKey) != u256.One) {
            throw new Revert('Player not active in this pool');
        }
    }

    private _requireGameStarted(poolId: u64, block: u64): void {
        const pKey = poolKey(poolId);
        if (this._started.get(pKey) != u256.One) {
            throw new Revert('Game not started yet');
        }
        const gameStart = this._gameStartBlock.get(pKey).toU64();
        if (block < gameStart) {
            throw new Revert('Waiting period not over');
        }
    }

    // Checkpoint points for a player (accumulate since last update)
    private _updatePoints(poolId: u64, player: Address, block: u64): void {
        const plKey     = playerKey(poolId, player);
        const stored    = this._ppPoints.get(plKey).toU64();
        const lastBlock = this._ppPointsUpdated.get(plKey).toU64();
        const earned    = block > lastBlock ? block - lastBlock : u64(0);
        this._ppPoints.set(plKey, u256.fromU64(stored + earned));
        this._ppPointsUpdated.set(plKey, u256.fromU64(block));

        // Update pool total points
        const pKey    = poolKey(poolId);
        const current = this._totalPoints.get(pKey).toU64();
        this._totalPoints.set(pKey, u256.fromU64(current + earned));
    }

    // Liquidate a player and distribute their funds
    private _liquidatePlayer(
        poolId: u64,
        target: Address,
        hunter: Address,
        tokenAddr: Address,
        block: u64,
        isManual: bool
    ): void {
        const pKey   = poolKey(poolId);
        const tKey   = playerKey(poolId, target);

        // Update target points one final time
        this._updatePoints(poolId, target, block);

        const deposit = this._ppDeposit.get(tKey).toU64();

        // Protocol fee
        const protocolAmt = (deposit * PROTOCOL_BPS) / BPS_BASE;

        // Hunter reward (only if manual)
        const hunterAmt = isManual ? (deposit * HUNTER_BPS) / BPS_BASE : u64(0);

        // Survivor distribution
        const toSurvivors = deposit - protocolAmt - hunterAmt;

        // Deactivate target
        this._ppActive.set(tKey, u256.Zero);
        const newActive = this._activeCount.get(pKey).toU64() - 1;
        this._activeCount.set(pKey, u256.fromU64(newActive));

        // Remove target points from pool total
        const targetPoints  = this._ppPoints.get(tKey).toU64();
        const currentTotal  = this._totalPoints.get(pKey).toU64();
        const newTotal      = currentTotal > targetPoints ? currentTotal - targetPoints : u64(0);
        this._totalPoints.set(pKey, u256.fromU64(newTotal));
        this._ppPoints.set(tKey, u256.Zero);

        // Distribute toSurvivors proportionally by points
        this._distributeToSurvivors(poolId, target, toSurvivors, newTotal, block);

        // Update total funds (reduce by deposit, add survivor share back)
        const currentFunds = this._totalFunds.get(pKey).toU64();
        this._totalFunds.set(pKey, u256.fromU64(currentFunds - protocolAmt - hunterAmt));

        // Pay protocol fee (keep in contract treasury for now — withdrawn by owner)
        // In mainnet version: send to deployer treasury address

        // Pay hunter
        if (isManual && hunterAmt > 0) {
            this._transfer(tokenAddr, hunter, hunterAmt);
        }

        this.emitEvent(new PlayerDiedEvent(poolId, target, deposit));
    }

    // Distribute toSurvivors proportionally to active players by points
    private _distributeToSurvivors(
        poolId: u64,
        exclude: Address,
        amount: u64,
        totalPoints: u64,
        block: u64
    ): void {
        if (totalPoints == 0 || amount == 0) return;
        const pKey      = poolKey(poolId);
        const activeNum = this._activeCount.get(pKey).toU64();

        // Iterate over all historical players (max 50) — find active ones
        const historical = this._historicalCount.get(pKey).toU64();

        for (let i: u64 = 0; i < historical; i++) {
            const listKey   = playerListKey(poolId, i);
            const addrU256  = this._playerList.get(listKey);
            if (addrU256 == u256.Zero) continue;
            const addr      = u256ToAddr(addrU256);
            if (addr == exclude) continue;

            const plKey  = playerKey(poolId, addr);
            if (this._ppActive.get(plKey) != u256.One) continue;

            // Update points first
            this._updatePoints(poolId, addr, block);

            const pts    = this._ppPoints.get(plKey).toU64();
            if (pts == 0) continue;

            // Share = amount * pts / totalPoints
            const share  = (amount * pts) / totalPoints;
            if (share == 0) continue;

            // Add share to player's deposit (they claim it when they win or are liquidated)
            const dep    = this._ppDeposit.get(plKey).toU64();
            this._ppDeposit.set(plKey, u256.fromU64(dep + share));
        }
    }

    // Check if game is over after a liquidation
    private _checkWinner(poolId: u64, tokenAddr: Address): BytesWriter {
        const pKey  = poolKey(poolId);
        const active = this._activeCount.get(pKey).toU64();
        const w = new BytesWriter(1 + 8);
        w.writeBoolean(active == 1);
        w.writeU64(active);
        return w;
    }

    private _toBaseUnits(tokens: u64): u64 {
        return tokens * 100_000_000; // 8 decimals
    }

    private _transferFrom(token: Address, from: Address, to: Address, amount: u64): void {
        const data = new BytesWriter(4 + 32 + 32 + 32);
        data.writeSelector(0x4b6685e7); // transferFrom(address,address,uint256)
        data.writeAddress(from);
        data.writeAddress(to);
        data.writeU256(u256.fromU64(amount));
        const result = Blockchain.call(token, data);
        if (!result.success) throw new Revert('transferFrom failed');
    }

    private _transfer(token: Address, to: Address, amount: u64): void {
        const data = new BytesWriter(4 + 32 + 32);
        data.writeSelector(0x3b88ef57); // transfer(address,uint256)
        data.writeAddress(to);
        data.writeU256(u256.fromU64(amount));
        const result = Blockchain.call(token, data);
        if (!result.success) throw new Revert('transfer failed');
    }
}
