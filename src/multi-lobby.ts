import { LitElement, html, customElement, property, css, internalProperty } from 'lit-element'
import type { SafeListener, Listener } from 'fancy-emitter'
import type { Client } from '@mothepro/fancy-p2p'
import type { MultiSelectedEvent } from '@material/mwc-list/mwc-list-foundation'
import type { NameChangeEvent, ProposalEvent } from './duo-lobby.js'
import type { Snackbar } from '@material/mwc-snackbar'

import '@material/mwc-button'
import '@material/mwc-list'
import '@material/mwc-list/mwc-check-list-item.js'
import '@material/mwc-icon-button'
import '@material/mwc-fab'
import '@material/mwc-textfield'
import '@material/mwc-snackbar'

type SnackBarClosingEvent = CustomEvent<{ reason?: string }>
type Proposal<E = Client['proposals']> = E extends SafeListener<infer T> ? T : void

declare global {
  interface HTMLElementEventMap {
    'p2p-error': ErrorEvent
    'name-change': NameChangeEvent
    proposal: ProposalEvent
  }
}

@customElement('p2p-multi-lobby')
export default class extends LitElement {
  /** Name of the user. An anonymous one may be set be the server if left unassigned. */
  @property({ type: String, reflect: true })
  name = ''

  /** Content to show in the snackbar's label given the current proposal. */
  @property({ type: Function, attribute: false })
  proposalLabel = ({ action, members, ack }: Proposal) => `
    ${action ? 'Join group with' : 'Waiting to join group with'}
    ${members.map(({name}) => name).join(', ')}
    (${ack.count + (action ? 0 : 1)} / ${1 + members.length})
    ${action ? '' : '...'}`

  /** Name of the user. An anonymous one may be set be the server if left unassigned. */
  @property({ type: Boolean, reflect: true, attribute: 'can-change-name' })
  canChangeName = false

  /** Max length of user's name */
  @property({ type: Number })
  maxlength = 100

  @property({ attribute: false })
  connection!: SafeListener<Client>

  @property({ attribute: false })
  groupExists!: (...clients: Client[]) => boolean

  /** Others connected to the lobby. */
  @internalProperty()
  private clients: Client[] = []

  @property({ type: Boolean, reflect: true })
  private editing = false

  /** The minimum number of other connections that can be made in the lobby. */
  @property({ type: Number, attribute: 'min-peers' })
  minPeers = 1

  /** The maximum number of other connections that can be made in the lobby. */
  @property({ type: Number, attribute: 'max-peers' })
  maxPeers = 10

  /** Automatically reject active proposal in milliseconds. Disabled by default (-1) */
  @property({ type: Number })
  timeout = -1

  @internalProperty({})
  private chosen: Set<Client> = new Set

  @internalProperty()
  proposal?: Proposal

  private readonly proposalQueue: Proposal[] = []

  get canPropose() {
    return this.minPeers <= this.chosen.size
      && this.chosen.size <= this.maxPeers
      && !this.groupExists(...this.chosen)
  }

  static readonly styles = css`
    :host([hidden]) {
      display: none;
    }
    
    /*
     * Doesn't suport icon buttons... for some reason.
     * https://github.com/material-components/material-components-web-components/blob/master/packages/snackbar/mwc-snackbar.scss
     */
    :host mwc-icon-button[slot="action"] {
      color: var(--mdc-snackbar-action-color, rgba(255, 255, 255, 0.87));
    }`

  protected async updated(changed: Map<string | number | symbol, unknown>) {
    if (changed.has('connection')) {
      this.clients = []
      for await (const client of this.connection!)
        this.bindClient(client)
    }

    // focus on the new textbox
    if (changed.has('editing') && this.editing) {
      await Promise.resolve() // wait a tick for material to catch up
      this.shadowRoot!.getElementById('field')!.focus()
    }
  }

  private bindClient = async (client: Client) => {
    this.clients = [...this.clients, client]
    for await (const { members, action, ack } of client.proposals) {
      this.proposalQueue.push({ members, action, ack })
      this.maybeSetActiveProposal()
      this.bindAcks(ack)
    }
    this.clients = this.clients.filter(currentClient => currentClient != client)
  }

  /** Update UI every time a client accepts or rejects the proposal */
  private async bindAcks(clientAcks: Listener<Client>) {
    try {
      for await (const client of clientAcks)
        this.requestUpdate() // updates # in snackbar
    } catch (error) {
      error.fatal = false
      this.dispatchEvent(new ErrorEvent('p2p-error', { error, bubbles: true }))
    }
    
    // Remove this from current proposal, or queue
    if (clientAcks == this.proposal?.ack)
      this.proposal = undefined
    for (const [index, { ack }] of this.proposalQueue.entries())
      if (clientAcks == ack)
        this.proposalQueue.splice(index, 1)
    
    this.maybeSetActiveProposal()
  }

  /** Accept proposal and remove buttons OR Reject proposal then remove it from list */
  private handleProposal({ detail: { reason } }: SnackBarClosingEvent) {
    this.proposal?.action!(reason == 'action')
    if (reason == 'action') {
      if (this.proposal?.action)
        this.proposal.action = undefined
      // Keep showing the snackbar
      ;(this.shadowRoot?.getElementById('active-proposal') as Snackbar)?.show()
      this.requestUpdate()
    } else {
      this.proposal = undefined
      this.maybeSetActiveProposal()
    }
  }

  private maybeSetActiveProposal() {
    if (this.proposal || !this.proposalQueue.length)
      return

    this.proposal = this.proposalQueue.shift()
    if (this.timeout > 10000) // Stupid mwc-snackbar has a limit on timeout for some reason...
      (this.shadowRoot?.getElementById('active-proposal') as Snackbar)?.close('dismiss')
  }

  /** Do not use form submission since that event doesn't pass through shadow dom */
  private nameChange({ target, key }: KeyboardEvent) {
    if (key == 'Enter') {
      const detail = (target as HTMLInputElement).value
      if (this.name != detail) {
        this.name = detail
        this.dispatchEvent(new CustomEvent('name-change', { detail }))
      }
      this.editing = false
    }
  }

  private selected({ detail: { index } }: MultiSelectedEvent) {
    // Double filter since it should exactly match the filter done for rendering
    this.chosen = new Set(this.clients
      .filter(({ isYou }) => !isYou)
      .filter((_, i) => index.has(i)))
  }

  protected readonly render = () => html`${this.editing
    // Editing own name textfield
    ? html`
      <mwc-textfield
        part="name-input"
        outlined
        charCounter
        type="text"
        label="Your Name"
        id="field"
        maxlength=${this.maxlength}
        value=${this.name}
        @keydown=${this.nameChange}
        @blur=${() => this.editing = false}
      ></mwc-textfield>`

    : this.canChangeName
      // Your name as an 'editable' button
      ? html`
      <mwc-button
        part="is-you can-edit"
        trailingIcon
        icon="create"
        label=${this.name}
        title="Change your name"
        @click=${() => this.editing = true}
      ></mwc-button>`

      // Your name plain-text
      : html`
      <span part="is-you can-not-edit">
        ${this.name}
      </span>`

    // In between
    }<slot></slot>${this.clients.filter(({ isYou }) => !isYou).length >= 1 // this.clients.length > 1

    // List of peers
    ? html`
    <mwc-list
      part="client-list"
      multi
      rootTabbable
      @selected=${this.selected}
    >${this.clients.filter(({ isYou }) => !isYou).map(({ name }) => html`
      <mwc-check-list-item part="client is-other">
        ${name}
      </mwc-check-list-item>`)}
    </mwc-list>`

    // All alone
    : html`<slot name="alone"></slot>`
    
    // Proposal
    }${this.proposal ? html`
      <mwc-snackbar
        open
        id="active-proposal"
        timeoutMs=${this.timeout > 10000 ? -1 : this.timeout}
        labelText="${this.proposalLabel(this.proposal).trim()}"
        @MDCSnackbar:closing=${this.handleProposal}>
        ${this.proposal.action ? html` 
          <mwc-icon-button slot="action" icon="check" label="accept"></mwc-icon-button>
          <mwc-icon-button slot="dismiss" icon="close" label="reject"></mwc-icon-button>` : ''}
      </mwc-snackbar>` : ''}
    <mwc-fab
      part="make-group ${!this.canPropose && 'mwc-fab-disabled'}"
      icon="done"
      ?disabled=${!this.canPropose}
      label="Make Group"
      @click=${() => this.canPropose
      && this.dispatchEvent(new CustomEvent('proposal', { detail: this.chosen }))
      && Promise.resolve().then(() => this.requestUpdate()) /* Update next tick to disable button */}
    ></mwc-fab>`
}
