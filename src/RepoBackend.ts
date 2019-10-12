import Queue from './Queue'
import { Metadata, sanitizeRemoteMetadata } from './Metadata'
import { Actor, ActorMsg } from './Actor'
import { Clock, strs2clock, clockDebug, clockActorIds } from './Clock'
import * as Base58 from 'bs58'
import * as crypto from 'hypercore/lib/crypto'
import { ToBackendQueryMsg, ToBackendRepoMsg, ToFrontendRepoMsg, DocumentMsg } from './RepoMsg'
import { Backend, Change } from 'automerge'
import * as DocBackend from './DocBackend'
import path from 'path'
import fs from 'fs'
import {
  notEmpty,
  ID,
  ActorId,
  DocId,
  RepoId,
  encodeRepoId,
  encodeDocId,
  rootActorId,
  encodeActorId,
  toDiscoveryId,
} from './Misc'
import Debug from 'debug'
import * as Keys from './Keys'
import FeedStore from './FeedStore'
import FileStore from './FileStore'
import FileServer from './FileServer'
import Network from './Network'
import NetworkPeer, { PeerId } from './NetworkPeer'
import { Swarm, JoinOptions } from './SwarmInterface'
import { PeerMsg } from './PeerMsg'
import ClockStore from './ClockStore'
import * as SqlDatabase from './SqlDatabase'
import MessageRouter, { Routed } from './MessageRouter'
import ram from 'random-access-memory'
import raf from 'random-access-file'
import KeyStore from './KeyStore'
import ReplicationManager, { Discovery } from './ReplicationManager'

Debug.formatters.b = Base58.encode

const log = Debug('repo:backend')

export interface FeedData {
  actorId: ActorId
  writable: Boolean
  changes: Change[]
}

export interface Options {
  path?: string
  memory?: boolean
}

export class RepoBackend {
  path?: string
  storage: Function
  feeds: FeedStore
  keys: KeyStore
  files: FileStore
  clocks: ClockStore
  actors: Map<ActorId, Actor> = new Map()
  docs: Map<DocId, DocBackend.DocBackend> = new Map()
  meta: Metadata
  opts: Options
  toFrontend: Queue<ToFrontendRepoMsg> = new Queue('repo:back:toFrontend')
  id: RepoId
  network: Network
  messages: MessageRouter<PeerMsg>
  replication: ReplicationManager
  swarmKey: Buffer // TODO: Remove this once we no longer use discovery-swarm/discovery-cloud
  private db: SqlDatabase.Database
  private fileServer: FileServer

  constructor(opts: Options) {
    this.opts = opts
    this.path = opts.path || 'default'

    // initialize storage
    if (!opts.memory) {
      ensureDirectoryExists(this.path)
    }
    this.storage = opts.memory ? ram : raf
    this.db = SqlDatabase.open(path.resolve(this.path, 'hypermerge.db'), opts.memory || false)

    this.keys = new KeyStore(this.db)
    this.feeds = new FeedStore(this.storageFn)
    this.files = new FileStore(this.feeds)

    // init repo
    const repoKeys = this.keys.get('self.repo') || this.keys.set('self.repo', Keys.createBuffer())
    this.swarmKey = repoKeys.publicKey
    this.id = encodeRepoId(repoKeys.publicKey)

    // initialize the various stores
    this.clocks = new ClockStore(this.db)
    this.files.writeLog.subscribe((header) => {
      this.meta.addFile(header.url, header.bytes, header.mimeType)
    })
    this.fileServer = new FileServer(this.files)

    this.replication = new ReplicationManager(this.feeds)
    this.meta = new Metadata(this.storageFn, this.join, this.leave)
    this.network = new Network(toPeerId(this.id))
    this.messages = new MessageRouter('HypermergeMessages')

    this.messages.inboxQ.subscribe(this.onMessage)
    this.replication.discoveryQ.subscribe(this.onDiscovery)
    this.network.peerQ.subscribe(this.onPeer)
    this.feeds.feedIdQ.subscribe((feedId) => {
      this.replication.addFeedIds([feedId])
    })
  }

  startFileServer = (path: string) => {
    if (this.fileServer.isListening()) return

    this.fileServer.listen(path)
    this.toFrontend.push({
      type: 'FileServerReadyMsg',
      path,
    })
  }

  private create(keys: Keys.KeyBuffer): DocBackend.DocBackend {
    const docId = encodeDocId(keys.publicKey)
    log('create', docId)
    const doc = new DocBackend.DocBackend(docId, Backend.init())
    doc.updateQ.subscribe(this.documentNotify)

    this.docs.set(docId, doc)

    this.meta.addActor(doc.id, rootActorId(doc.id))

    this.initActor(keys)

    return doc
  }

  private debug(id: DocId) {
    const doc = this.docs.get(id)
    const short = id.substr(0, 5)
    if (doc === undefined) {
      console.log(`doc:backend NOT FOUND id=${short}`)
    } else {
      console.log(`doc:backend id=${short}`)
      console.log(`doc:backend clock=${clockDebug(doc.clock)}`)
      const local = this.meta.localActorId(id)
      const actors = this.meta.actors(id)
      const info = actors
        .map((actor) => {
          const nm = actor.substr(0, 5)
          return local === actor ? `*${nm}` : nm
        })
        .sort()
      console.log(`doc:backend actors=${info.join(',')}`)
    }
  }

  private destroy(id: DocId) {
    this.meta.delete(id)
    const doc = this.docs.get(id)
    if (doc) {
      this.docs.delete(id)
    }
    const actors = this.meta.allActors()
    this.actors.forEach((actor, id) => {
      if (!actors.has(id)) {
        console.log('Orphaned actors - will purge', id)
        this.actors.delete(id)
        this.leave(actor.id)
        actor.destroy()
      }
    })
  }

  // opening a file fucks it up
  private open(docId: DocId): DocBackend.DocBackend {
    //    log("open", docId, this.meta.forDoc(docId));
    if (this.meta.isFile(docId)) {
      throw new Error('trying to open a file like a document')
    }
    let doc = this.docs.get(docId)
    if (!doc) {
      doc = new DocBackend.DocBackend(docId)
      doc.updateQ.subscribe(this.documentNotify)
    }
    if (!this.docs.has(docId)) {
      this.docs.set(docId, doc)
      this.meta.addActor(docId, rootActorId(docId))
      this.loadDocument(doc)
    }
    return doc
  }

  merge(id: DocId, clock: Clock) {
    this.meta.merge(id, clock)
    this.syncReadyActors(clockActorIds(clock))
  }

  /*
  follow(id: string, target: string) {
    this.meta.follow(id, target);
    this.syncReadyActors(this.meta.actors(id));
  }
*/

  close = () => {
    this.actors.forEach((actor) => actor.close())
    this.actors.clear()
    this.db.close()

    return Promise.all([
      this.feeds.close(),
      this.replication.close(),
      this.network.close(),
      this.fileServer.close(),
    ])
  }

  private async allReadyActors(docId: DocId): Promise<Actor[]> {
    const actorIds = await this.meta.actorsAsync(docId)
    return Promise.all(actorIds.map(this.getReadyActor))
  }

  private async loadDocument(doc: DocBackend.DocBackend) {
    const actors = await this.allReadyActors(doc.id)
    log(`load document 2 actors=${actors.map((a) => a.id)}`)
    const changes: Change[] = []
    actors.forEach((actor) => {
      const max = this.meta.clockAt(doc.id, actor.id)
      const slice = actor.changes.slice(0, max)
      doc.changes.set(actor.id, slice.length)
      log(`change actor=${ID(actor.id)} changes=0..${slice.length}`)
      changes.push(...slice)
    })
    log(`loading doc=${ID(doc.id)} changes=${changes.length}`)
    // Check to see if we already have a local actor id. If so, re-use it.
    const localActorId = this.meta.localActorId(doc.id)
    const actorId = localActorId
      ? (await this.getReadyActor(localActorId)).id
      : this.initActorFeed(doc)
    doc.init(changes, actorId)
  }

  join = (actorId: ActorId) => {
    this.network.join(toDiscoveryId(actorId))
  }

  leave = (actorId: ActorId) => {
    this.network.leave(toDiscoveryId(actorId))
  }

  private getReadyActor = (actorId: ActorId): Promise<Actor> => {
    const publicKey = Base58.decode(actorId)
    const actor = this.actors.get(actorId) || this.initActor({ publicKey })
    const actorPromise = new Promise<Actor>((resolve, reject) => {
      try {
        actor.onReady(resolve)
      } catch (e) {
        reject(e)
      }
    })
    return actorPromise
  }

  storageFn = (path: string) => {
    return (name: string) => {
      return this.storage(this.path + '/' + path + '/' + name)
    }
  }

  initActorFeed(doc: DocBackend.DocBackend): ActorId {
    log('initActorFeed', doc.id)
    const keys = crypto.keyPair()
    const actorId = encodeActorId(keys.publicKey)
    this.meta.addActor(doc.id, actorId)
    this.initActor(keys)
    return actorId
  }

  actorIds(doc: DocBackend.DocBackend): ActorId[] {
    return this.meta.actors(doc.id)
  }

  docActors(doc: DocBackend.DocBackend): Actor[] {
    return this.actorIds(doc)
      .map((id) => this.actors.get(id))
      .filter(notEmpty)
  }

  syncReadyActors = (ids: ActorId[]) => {
    ids.forEach(async (id) => {
      const actor = await this.getReadyActor(id)
      this.syncChanges(actor)
    })
  }

  private getGoodClock(doc: DocBackend.DocBackend): Clock | undefined {
    const minimumClockSatisfied = this.clocks.has(this.id, doc.id)
    return minimumClockSatisfied
      ? doc.clock
      : this.clocks.getMaximumSatisfiedClock(doc.id, doc.clock)
  }

  private documentNotify = (msg: DocBackend.DocBackendMessage) => {
    switch (msg.type) {
      case 'ReadyMsg': {
        const doc = msg.doc
        const goodClock = this.getGoodClock(doc)
        this.toFrontend.push({
          type: 'ReadyMsg',
          id: doc.id,
          minimumClockSatisfied: !!goodClock,
          actorId: doc.actorId,
          history: msg.history,
          patch: msg.patch,
        })
        break
      }
      case 'ActorIdMsg': {
        this.toFrontend.push({
          type: 'ActorIdMsg',
          id: msg.id,
          actorId: msg.actorId,
        })
        break
      }
      case 'RemotePatchMsg': {
        const doc = msg.doc
        const goodClock = this.getGoodClock(doc)
        if (goodClock) {
          this.clocks.update(this.id, doc.id, goodClock)
        }
        this.toFrontend.push({
          type: 'PatchMsg',
          id: doc.id,
          minimumClockSatisfied: !!goodClock,
          patch: msg.patch,
          history: msg.history,
        })
        break
      }
      case 'LocalPatchMsg': {
        const doc = msg.doc
        if (!doc.actorId) return

        this.actor(doc.actorId)!.writeChange(msg.change)

        const goodClock = this.getGoodClock(doc)
        if (goodClock) {
          this.clocks.update(this.id, doc.id, goodClock)
        }

        this.toFrontend.push({
          type: 'PatchMsg',
          id: doc.id,
          minimumClockSatisfied: !!goodClock,
          patch: msg.patch,
          history: msg.history,
        })
        break
      }
      default: {
        console.log('Unknown message type', msg)
      }
    }
  }

  onPeer = (peer: NetworkPeer): void => {
    this.messages.listenTo(peer)
    this.replication.onPeer(peer)
  }

  onDiscovery = ({ feedId, peer }: Discovery) => {
    const actorId = feedId as ActorId

    const blocks = this.meta.forActor(actorId)

    const docs = this.meta.docsWith(actorId)
    const clocks = this.clocks.getMultiple(this.id, docs)

    this.messages.sendToPeer(peer, {
      type: 'RemoteMetadata',
      clocks,
      blocks,
    })
  }

  private onMessage = ({ sender, msg }: Routed<PeerMsg>) => {
    switch (msg.type) {
      case 'RemoteMetadata': {
        const { blocks, clocks } = sanitizeRemoteMetadata(msg)

        for (let docId in clocks) {
          const remoteClock = clocks[docId]
          const [clock] = this.clocks.update(sender.id, docId as DocId, remoteClock)
        }
        this.meta.addBlocks(blocks)
        blocks.map((block) => {
          if ('actors' in block && block.actors) this.syncReadyActors(block.actors)
          if ('merge' in block && block.merge) this.syncReadyActors(clockActorIds(block.merge))
          // if (block.follows) block.follows.forEach(id => this.open(id))
        })
        break
      }

      case 'DocumentMessage': {
        const { contents, id } = msg as DocumentMsg
        this.toFrontend.push({
          type: 'DocumentMessage',
          id,
          contents,
        })
        break
      }
    }
  }

  private actorNotify = (msg: ActorMsg) => {
    switch (msg.type) {
      case 'ActorFeedReady': {
        const actor = msg.actor
        // Record whether or not this actor is writable.
        this.meta.setWritable(actor.id, msg.writable)

        // Broadcast latest document information to peers.
        const blocks = this.meta.forActor(actor.id)
        const docs = this.meta.docsWith(actor.id)
        const clocks = this.clocks.getMultiple(this.id, docs)
        const discoveryIds = this.meta.docsWith(actor.id).map(toDiscoveryId)
        const peers = this.replication.getPeersWith(discoveryIds)

        this.messages.sendToPeers(peers, {
          type: 'RemoteMetadata',
          blocks,
          clocks,
        })

        this.join(actor.id)

        break
      }
      case 'ActorInitialized': {
        // Swarm on the actor's feed.
        this.join(msg.actor.id)
        break
      }
      case 'ActorSync':
        log('ActorSync', msg.actor.id)
        this.syncChanges(msg.actor)
        break
      case 'Download':
        this.meta.docsWith(msg.actor.id).forEach((docId) => {
          this.toFrontend.push({
            type: 'ActorBlockDownloadedMsg',
            id: docId,
            actorId: msg.actor.id,
            index: msg.index,
            size: msg.size,
            time: msg.time,
          })
        })
        break
    }
  }

  private initActor(keys: Keys.KeyBuffer): Actor {
    const actor = new Actor({
      keys,
      notify: this.actorNotify,
      store: this.feeds,
    })
    this.actors.set(actor.id, actor)
    this.replication.addFeedIds([actor.id])
    return actor
  }

  syncChanges = (actor: Actor) => {
    const actorId = actor.id
    const docIds = this.meta.docsWith(actorId)
    docIds.forEach((docId) => {
      const doc = this.docs.get(docId)
      if (doc) {
        doc.ready.push(() => {
          const max = this.meta.clockAt(docId, actorId)
          const min = doc.changes.get(actorId) || 0
          const changes = []
          let i = min
          for (; i < max && actor.changes.hasOwnProperty(i); i++) {
            const change = actor.changes[i]
            log(`change found xxx id=${ID(actor.id)} seq=${change.seq}`)
            changes.push(change)
          }
          doc.changes.set(actorId, i)
          //        log(`changes found xxx doc=${ID(docId)} actor=${ID(actor.id)} n=[${min}+${changes.length}/${max}]`);
          if (changes.length > 0) {
            log(`applyremotechanges ${changes.length}`)
            doc.applyRemoteChanges(changes)
          }
        })
      }
    })
  }

  setSwarm = (swarm: Swarm, joinOptions?: JoinOptions) => {
    this.network.setSwarm(swarm, joinOptions)
  }

  subscribe = (subscriber: (message: ToFrontendRepoMsg) => void) => {
    this.toFrontend.subscribe(subscriber)
  }

  handleQuery = (id: number, query: ToBackendQueryMsg) => {
    switch (query.type) {
      case 'MetadataMsg': {
        this.meta.publicMetadata(query.id, (payload) => {
          this.toFrontend.push({ type: 'Reply', id, payload })
        })
        break
      }
      case 'MaterializeMsg': {
        const doc = this.docs.get(query.id)!
        const changes = (doc.back as any)
          .getIn(['opSet', 'history'])
          .slice(0, query.history)
          .toArray()
        const [, patch] = Backend.applyChanges(Backend.init(), changes)
        this.toFrontend.push({ type: 'Reply', id, payload: patch })
        break
      }
    }
  }

  receive = (msg: ToBackendRepoMsg) => {
    switch (msg.type) {
      case 'NeedsActorIdMsg': {
        const doc = this.docs.get(msg.id)!
        const actorId = this.initActorFeed(doc)
        doc.initActor(actorId)
        break
      }
      case 'RequestMsg': {
        const doc = this.docs.get(msg.id)!
        doc.applyLocalChange(msg.request)
        break
      }
      case 'Query': {
        const query = msg.query
        const id = msg.id
        this.handleQuery(id, query)
        break
      }
      case 'CreateMsg': {
        const keys = {
          publicKey: Keys.decode(msg.publicKey),
          secretKey: Keys.decode(msg.secretKey),
        }
        this.create(keys)
        break
      }
      case 'MergeMsg': {
        this.merge(msg.id, strs2clock(msg.actors))
        break
      }
      /*
        case "FollowMsg": {
          this.follow(msg.id, msg.target);
          break;
        }
*/
      case 'OpenMsg': {
        this.open(msg.id)
        break
      }
      case 'DocumentMessage': {
        // Note: 'id' is the document id of the document to send the message to.
        const { id, contents } = msg
        const peers = this.replication.getPeersWith([toDiscoveryId(id)])
        this.messages.sendToPeers(peers, {
          type: 'DocumentMessage',
          id,
          contents,
        })

        break
      }
      case 'DestroyMsg': {
        this.destroy(msg.id)
        break
      }
      case 'DebugMsg': {
        this.debug(msg.id)
        break
      }
      case 'CloseMsg': {
        this.close()
        break
      }
    }
  }

  actor(id: ActorId): Actor | undefined {
    return this.actors.get(id)
  }
}

function ensureDirectoryExists(path: string) {
  fs.mkdirSync(path, { recursive: true })
}

function toPeerId(repoId: RepoId): PeerId {
  return repoId as PeerId
}
