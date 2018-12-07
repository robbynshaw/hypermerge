"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
const hypercore_1 = require("./hypercore");
const Queue_1 = __importDefault(require("./Queue"));
const JsonBuffer = __importStar(require("./JsonBuffer"));
const Base58 = __importStar(require("bs58"));
const debug_1 = __importDefault(require("debug"));
const log = debug_1.default("feedmgr");
const KB = 1024;
const MB = 1024 * KB;
exports.EXT = "hypermerge.2";
class Actor {
    constructor(config) {
        this.changes = [];
        this.peers = new Set();
        this.data = [];
        this.feedReady = () => {
            log("init feed", this.id);
            const feed = this.feed;
            this.meta.setWritable(this.id, feed.writable);
            this.meta.docsWith(this.id).forEach(docId => {
                this.message(this.meta.forActor(docId));
            });
            feed.on("peer-remove", this.peerRemove);
            feed.on("peer-add", this.peerAdd);
            feed.on("download", this.handleDownload);
            feed.on("sync", this.sync);
            hypercore_1.readFeed(feed, this.init); // subscibe begins here
            feed.on("close", this.close);
        };
        this.init = (datas) => {
            datas.map((data, i) => this.handleBlock(i, data));
            if (datas.length > 0) {
                this.syncQ.subscribe(f => f());
            }
            this.q.subscribe(f => f(this));
        };
        this.peerRemove = (peer) => {
            this.peers.delete(peer);
            this.notify({ type: "PeerUpdate", actor: this, peers: this.peers.size });
        };
        this.peerAdd = (peer) => {
            peer.stream.on("extension", (ext, input) => {
                if (ext === exports.EXT) {
                    this.notify({ type: "NewMetadata", input });
                }
            });
            this.peers.add(peer);
            this.message(this.meta.forActor(this.id), peer);
            this.notify({ type: "PeerUpdate", actor: this, peers: this.peers.size });
        };
        this.close = () => {
            log("closing feed", this.id);
        };
        this.sync = () => {
            this.syncQ.once(f => f());
            this.notify({ type: "ActorSync", actor: this });
        };
        this.handleDownload = (idx, data) => {
            this.handleBlock(idx, data);
            this.notify({ type: "Download", actor: this, index: idx });
        };
        this.handleBlock = (idx, data) => {
            switch (this.type) {
                case "Automerge":
                    this.changes.push(JsonBuffer.parse(data));
                    break;
                default:
                    if (idx === 0) {
                        this.handleFeedHead(JsonBuffer.parse(data));
                    }
                    else {
                        this.data[idx - 1] = data;
                    }
                    break;
            }
        };
        this.push = (cb) => {
            this.q.push(cb);
        };
        const { publicKey, secretKey } = config.keys;
        const dk = hypercore_1.discoveryKey(publicKey);
        const id = Base58.encode(publicKey);
        this.type = "Unknown";
        this.id = id;
        this.notify = config.notify;
        this.meta = config.meta;
        this.dkString = Base58.encode(dk);
        this.feed = hypercore_1.hypercore(config.storage(id), publicKey, { secretKey });
        this.q = new Queue_1.default();
        this.syncQ = new Queue_1.default();
        this.feed.ready(this.feedReady);
    }
    message(message, target) {
        const peers = target ? [target] : [...this.peers];
        const payload = Buffer.from(JSON.stringify(message));
        peers.forEach(peer => peer.stream.extension(exports.EXT, payload));
    }
    handleFeedHead(head) {
        if (head.hasOwnProperty("type")) {
            this.type = "File";
            this.fileMetadata = head;
        }
        else {
            this.type = "Automerge";
            this.changes.push(head);
            this.changes.push(...this.data.filter(data => data).map(data => JsonBuffer.parse(data)));
            this.data = [];
        }
    }
    writeFile(data) {
        this.q.push(() => {
            if (this.data.length > 0 || this.changes.length > 0)
                throw new Error("writeFile called on existing feed");
            const head = { type: "File", bytes: data.length };
            this.append(Buffer.from(JSON.stringify(head)));
            const blockSize = 1 * MB;
            for (let i = 0; i < data.length; i += blockSize) {
                const block = data.slice(i, i + blockSize);
                this.append(block);
            }
        });
    }
    readFile(cb) {
        this.syncQ.push(() => {
            // could ditch .data and re-read blocks here
            console.log(`Rebuilding file from ${this.data.length} blocks`);
            const file = Buffer.concat(this.data);
            const bytes = this.fileMetadata.bytes;
            if (file.length !== bytes) {
                throw new Error(`File metadata error - file=${file.length} meta=${bytes}`);
            }
            cb(file);
        });
    }
    append(block) {
        this.feed.append(block, err => {
            if (err) {
                throw new Error("failed to append to feed");
            }
        });
    }
    writeChange(change) {
        const feedLength = this.changes.length;
        const ok = feedLength + 1 === change.seq;
        log(`write actor=${this.id} seq=${change.seq} feed=${feedLength} ok=${ok}`);
        this.changes.push(change);
        this.sync();
        this.append(JsonBuffer.bufferify(change));
    }
}
exports.Actor = Actor;
//# sourceMappingURL=Actor.js.map