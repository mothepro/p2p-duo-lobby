import type { NameChangeEvent, ProposalEvent } from './duo-lobby.js'
import { LitElement, html, customElement, property, PropertyValues } from 'lit-element'
import P2P, { State } from '@mothepro/fancy-p2p'
import { MockPeer } from '@mothepro/fancy-p2p/dist/esm/src/Peer.js' // update fancy-p2p

import './duo-lobby.js'
import './multi-lobby.js'

/** The useful P2P functions once the connections have been made. */
export type readyP2P = Readonly<Pick<P2P, 'broadcast' | 'random' | 'peers'>>

/** Keys for storing data in local storage */
export const enum Keys {
  /** The name of the user to connect in the lobby as. */
  NAME = 'p2p-name'
}

declare global {
  interface HTMLElementEventMap {
    'p2p-error': ErrorEvent
    'p2p-update': CustomEvent<boolean>
  }
  interface Window {
    /** Bindings from a ready `fancy-p2p` instance set on window by `lit-p2p`. */
    p2p: readyP2P
  }
  /** Bindings from a ready `fancy-p2p` instance set on window by `lit-p2p`. */
  let p2p: Window['p2p']
}

const mockPeer = new MockPeer(''),
  mockReadyP2P = {
    peers: [mockPeer],
    broadcast: mockPeer.send,
    random: (isInt = false) => isInt
      ? Math.trunc(2 ** 32 * Math.random() - 2 ** 31)
      : Math.random(),
  }

let exposedP2P: readyP2P | void
Object.defineProperty(window, 'p2p', {
  configurable: true,
  get: () => exposedP2P ?? mockReadyP2P,
  // TODO destruct and rebuild `data` to remove access to the real `p2p` props?
  set: function (data: readyP2P) {
    if (data != exposedP2P) {
      exposedP2P = data
      dispatchEvent(new CustomEvent('p2p-update', {
        detail: data.peers.length > 1,
        bubbles: true,
        composed: true
      }))
    }
  },
});

@customElement('lit-p2p')
export default class extends LitElement {
  /**
   * State of the underlying P2P instance.
   * Defaults to `-1` Disconnected (not connected & not trying to).
   */
  @property({ type: Number, reflect: true })
  state = -1

  /**
   * Name of the user.
   * 
   * An anonymous one *may* be set be the server if left unassigned.
   * This attribute is updated to match what the signaling server returns as your name.
   */
  @property({ type: String, reflect: true })
  name = ''

  /** List of STUN servers to broker P2P connections. */
  @property({ type: Array })
  stuns!: string[]

  /** Address to the signaling server. */
  @property({ type: String })
  signaling!: string

  /** Version of the signaling server. */
  @property({ type: String })
  version!: string

  /** Number of times to attempt to make an RTC connection. Defaults to 1 */
  @property({ type: Number })
  retries!: number

  @property({ type: String })
  lobby!: string

  /** The number of milliseconds to wait before giving up on the direct connection. Doesn't give up by default */
  @property({ type: Number })
  timeout!: number

  /** The number of milliseconds to wait before rejecting a proposal (when maxpeers > 1). Doesn't give up by default */
  @property({ type: Number })
  proposalTimeout = -1

  /** Whether to use the signaling server as a fallback when a direct connection to peer can not be established. */
  @property({ type: Boolean })
  fallback = false

  /** Whether to store the user's name in local storage. */
  @property({ type: Boolean, attribute: 'local-storage' })
  localStorage = false

  /** Max length of user's name */
  @property({ type: Number, attribute: 'max-length' })
  maxlength = 50

  /** The minimum number of other connections that can be made in the lobby. */
  @property({ type: Number, attribute: 'min-peers' })
  minPeers = 1

  /** The maximum number of other connections that can be made in the lobby. */
  @property({ type: Number, attribute: 'max-peers' })
  maxPeers = 1

  public p2p?: P2P

  protected async updated(changed: PropertyValues) {
    if (changed.has('name'))
      // @ts-ignore Reset mock peer's name
      mockPeer.name = this.name

    if (changed.has('state'))
      switch (this.state) {
        case State.OFFLINE: // Try to get name and reconnect to server
          if (this.localStorage && !this.name)
            this.name = (localStorage.getItem(Keys.NAME) ?? '').toString()
          this.connect()
          break

        case State.READY: // Bind established p2p to the global `window.p2p`
          p2p = this.p2p! // Don't destruct to allow easier debugging
          break
        
        case State.LOADING: // NOOPs
        case State.LOBBY:
          break
        
        default: // Disconnect & reset `window.p2p` to mocked
          this.p2p?.stateChange.cancel()
          p2p = mockReadyP2P
          this.requestUpdate() // since render has already been called, ensure we are disconnected now.
          break
      }
    else if (changed.has('lobby') || changed.has('signaling') || changed.has('version'))
      // Only reconnect if we are using the signaling server
      if (this.state == State.OFFLINE || this.state == State.LOBBY)
        this.connect()
  }

  /** Attempt to connect to the lobby */
  private async connect() {
    try {
      // Wait for any exisiting connection to close
      await this.p2p?.stateChange.cancel().on(() => {}).catch(() => {})

      this.p2p = new P2P({
        name: this.name,
        retries: this.retries,
        timeout: this.timeout,
        stuns: this.stuns,
        lobby: this.lobby,
        fallback: this.fallback,
        server: {
          address: this.signaling,
          version: this.version,
        },
      })

      // Set the name attribute to the name of my client. This ensures that we are consistent with server.
      this.p2p.lobbyConnection.next.then(({ name }) => this.name = name)

      for await (const state of this.p2p!.stateChange)
        this.state = state
    } catch (error) {
      this.dispatchEvent(new ErrorEvent('p2p-error', { error, bubbles: true }))
    } finally {
      this.state = -1
    }
  }

  /** Only called when the **user** changes their own name. */
  // TODO the only reason we do this instead of in the updater is to **not** save the random server name in local storage.
  // this prevents name changes in attribute from reconnecting
  private saveNameAndReconnect({ detail }: NameChangeEvent) {
    this.name = detail
    if (this.localStorage && this.name)
      localStorage.setItem(Keys.NAME, this.name)
    this.connect()
  }

  private proposal({ detail }: ProposalEvent) {
    try {
      this.p2p?.proposeGroup(...detail)
    } catch (error) {
      this.dispatchEvent(new ErrorEvent('p2p-error', { error, bubbles: true }))
    }
  }

  // TODO sometimes the lobbies are bound after the first connection has landed :/
  protected readonly render = () => {
    if (this.p2p?.stateChange.isAlive)
      switch (this.p2p.state) {
        case State.LOBBY:
          return this.minPeers == 1 && this.maxPeers == 1
            ? html`
            <slot></slot>
            <p2p-duo-lobby
              part="lobby"
              exportparts="client-list , client , is-you , is-other , can-edit , can-not-edit , name-input , accept , reject , waiting , invite"
              name=${this.name}
              maxlength=${this.maxlength}
              ?can-change-name=${this.localStorage}
              .connection=${this.p2p.lobbyConnection}
              .groupExists=${this.p2p.groupExists}
              @name-change=${this.saveNameAndReconnect}
              @proposal=${this.proposal}
            >
              <slot name="p2p-lobby"></slot>
              <slot name="p2p-alone" slot="alone"></slot>
            </p2p-duo-lobby>`
            : html`
            <slot></slot>
            <p2p-multi-lobby
              part="lobby"
              exportparts="client-list , client , is-you , is-other , can-edit , can-not-edit , name-input , make-group , mwc-fab-disabled"
              name=${this.name}
              timeout=${this.proposalTimeout}
              maxlength=${this.maxlength}
              max-peers=${this.maxPeers}
              min-peers=${this.minPeers}
              ?can-change-name=${this.localStorage}
              .connection=${this.p2p.lobbyConnection}
              .groupExists=${this.p2p.groupExists}
              @name-change=${this.saveNameAndReconnect}
              @proposal=${this.proposal}
            >
              <slot name="p2p-lobby"></slot>
              <slot name="p2p-alone" slot="alone"></slot>
            </p2p-multi-lobby>`

        case State.READY:
          return html`
            <slot></slot>
            <slot name="p2p-ready"></slot>`

        case State.OFFLINE:
          return html`
            <slot></slot>
            <slot name="p2p-offline"></slot>`

        case State.LOADING:
          return html`
            <slot></slot>
            <slot name="p2p-loading"></slot>`
      }

    return html`
      <slot></slot>
      <slot name="p2p-disconnected"></slot>`
  }
}
