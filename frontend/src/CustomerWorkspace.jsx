import { useCallback, useEffect, useState } from 'react'
import WorkspaceFrame, { ErrorMessage } from './WorkspaceFrame.jsx'
import { api } from './lib/api.js'
import { getMessageErrorMessage } from './lib/seoValidation.js'
import { POLL_INTERVALS, schedulePolling } from './lib/polling.js'

function ProtectedCustomerWorkspace({ path, conversationId = '' }) {
  const [state, setState] = useState('checking')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    api.refresh().then((result) => {
      if (!active) return
      api.setAccessToken(result.accessToken)
      setState('ready')
    }).catch((cause) => {
      if (!active) return
      if (cause.status === 401 || cause.status === 403) setState('signed-out')
      else {
        setError(cause.message)
        setState('error')
      }
    })
    return () => { active = false }
  }, [])

  if (state === 'checking') return <WorkspaceFrame><p role="status">Restoring your secure session…</p></WorkspaceFrame>
  if (state === 'signed-out') {
    const returnTo = encodeURIComponent(path)
    return <WorkspaceFrame><h1>Sign in to continue</h1><p>Your secure session has expired.</p><a className="button button-primary" href={`/login?returnTo=${returnTo}`}>Sign in</a></WorkspaceFrame>
  }
  if (state === 'error') return <WorkspaceFrame><h1>Workspace unavailable</h1><ErrorMessage>{error}</ErrorMessage></WorkspaceFrame>

  if (path === '/favorites') return <FavoritesWorkspace />
  if (path === '/notifications') return <NotificationsWorkspace />
  if (conversationId) return <ConversationWorkspace conversationId={conversationId} />
  return <InboxWorkspace />
}

function FavoritesWorkspace() {
  const [items, setItems] = useState([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setError('')
    try {
      const result = await api.getFavorites()
      setItems(result.items || [])
    } catch (cause) {
      setError(cause.payload?.error || cause.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(refresh, 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  async function removeFavorite(id) {
    setError('')
    try {
      await api.removeFavorite(id)
      setItems((current) => current.filter((item) => item.id !== id))
    } catch (cause) {
      setError(cause.payload?.error || cause.message)
    }
  }

  return (
    <WorkspaceFrame>
      <section className="customer-workspace">
        <p className="eyebrow">Your collection</p><h1>Favorites</h1>
        <ErrorMessage>{error}</ErrorMessage>
        {loading ? <p role="status">Loading your favorites…</p> : items.length === 0
          ? <p role="status">You have no saved listings yet.</p>
          : <ul className="customer-listing-grid">
            {items.map((item) => (
              <li className="customer-listing-card" key={item.id}>
                <a href={`/listing/${encodeURIComponent(item.canonicalKey || item.id)}`}>
                  <strong>{item.title}</strong>
                  <span>PKR {item.asking_price}</span>
                  <span>{item.sold ? 'Sold' : item.removed ? 'No longer available' : item.reserved ? 'Reserved' : item.unavailable ? 'Temporarily unavailable' : 'Available'}</span>
                </a>
                <button className="text-button" type="button" onClick={() => removeFavorite(item.id)}>Remove favorite</button>
              </li>
            ))}
          </ul>}
      </section>
    </WorkspaceFrame>
  )
}

function InboxWorkspace() {
  const [conversations, setConversations] = useState([])
  const [error, setError] = useState('')
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const result = await api.getConversationInbox()
      setConversations(result.conversations || [])
      setUnreadCount((result.conversations || []).reduce((total, item) => total + Number(item.unread_count || 0), 0))
      setError('')
    } catch (cause) {
      setError(cause.payload?.error || cause.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(refresh, 0)
    const stopPolling = schedulePolling(refresh, POLL_INTERVALS.inbox)
    return () => {
      window.clearTimeout(timer)
      stopPolling()
    }
  }, [refresh])

  return (
    <WorkspaceFrame>
      <section className="customer-workspace">
        <p className="eyebrow">Messages</p><h1>Inbox</h1>
        <p className="customer-unread" aria-live="polite">{unreadCount} unread message{unreadCount === 1 ? '' : 's'} · updates every 60 seconds</p>
        <ErrorMessage>{error}</ErrorMessage>
        {loading ? <p role="status">Loading your conversations…</p> : conversations.length === 0
          ? <p role="status">Your conversations will appear here.</p>
          : <ul className="conversation-list">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <a href={`/inbox/${encodeURIComponent(conversation.id)}`}>
                  <span className="conversation-title">Listing conversation</span>
                  <span>Listing reference: {conversation.listing_id}</span>
                  {conversation.last_message_body && <span className="conversation-preview">{conversation.last_message_body}</span>}
                  <span>{conversation.unread_count ? `${conversation.unread_count} unread` : 'No unread messages'}</span>
                </a>
                <time dateTime={conversation.last_activity_at}>{new Date(conversation.last_activity_at).toLocaleString()}</time>
              </li>
            ))}
          </ul>}
      </section>
    </WorkspaceFrame>
  )
}

function ConversationWorkspace({ conversationId }) {
  const [conversation, setConversation] = useState(null)
  const [messages, setMessages] = useState([])
  const [messageText, setMessageText] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [readOnlyReason, setReadOnlyReason] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)

  const refreshMessages = useCallback(async () => {
    try {
      const result = await api.getConversationMessages(conversationId)
      await api.markConversationRead(conversationId)
      setMessages(result.messages || [])
      setError('')
    } catch (cause) {
      setError(cause.payload?.error || cause.message)
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  const refreshInbox = useCallback(async () => {
    try {
      const result = await api.getConversationInbox()
      const found = (result.conversations || []).find((item) => item.id === conversationId)
      if (!found) {
        setError('This conversation is no longer available.')
        return
      }
      setConversation(found)
    } catch (cause) {
      setError(cause.payload?.error || cause.message)
    }
  }, [conversationId])

  useEffect(() => {
    let active = true
    async function loadListingStatus() {
      try {
        const status = await api.getListingStatus(conversation?.listing_id)
        if (active && (status.sold || status.removed || status.unavailable)) {
          setReadOnlyReason(status.sold ? 'This listing has been sold.' : status.removed ? 'This listing was removed.' : 'This listing is no longer published.')
        }
      } catch (cause) {
        if (!active) return
        if (cause.status === 410) setReadOnlyReason('This listing was removed.')
        else if (cause.status === 404) setReadOnlyReason('This listing is no longer available.')
        else setError(cause.payload?.error || cause.message)
      }
    }
    if (!conversation?.listing_id) return () => { active = false }
    const timer = window.setTimeout(loadListingStatus, 0)
    const stopPolling = schedulePolling(loadListingStatus, POLL_INTERVALS.unread)
    return () => {
      active = false
      window.clearTimeout(timer)
      stopPolling()
    }
  }, [conversation?.listing_id])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      refreshInbox()
      refreshMessages()
    }, 0)
    const stopChatPolling = schedulePolling(refreshMessages, POLL_INTERVALS.openChat)
    const stopInboxPolling = schedulePolling(refreshInbox, POLL_INTERVALS.unread)
    return () => {
      window.clearTimeout(timer)
      stopChatPolling()
      stopInboxPolling()
    }
  }, [refreshInbox, refreshMessages])

  async function sendMessage(event) {
    event.preventDefault()
    if (!messageText.trim() || sending || readOnlyReason) return
    setSending(true)
    setError('')
    setMessage('')
    try {
      const result = await api.sendConversationMessage(conversationId, messageText)
      setMessages((current) => [result, ...current])
      setMessageText('')
    } catch (cause) {
      setError(getMessageErrorMessage(cause))
    } finally {
      setSending(false)
    }
  }

  return (
    <WorkspaceFrame>
      <section className="customer-workspace conversation-workspace">
        <p className="eyebrow">Messages · updates every 15 seconds</p><h1>Chat thread</h1>
        <a href="/inbox">← Back to inbox</a>
        {conversation && <p className="form-hint">Listing reference: {conversation.listing_id}</p>}
        {readOnlyReason && <p className="read-only-banner" role="status">Read-only conversation. {readOnlyReason} You can still read previous messages.</p>}
        <ErrorMessage>{error}</ErrorMessage>
        {message && <p role="status">{message}</p>}
        {loading ? <p role="status">Loading messages…</p> : <ol className="thread-messages">
          {[...messages].reverse().map((item) => (
            <li key={item.id}>
              <p>{item.body}</p>
              <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time>
            </li>
          ))}
          {messages.length === 0 && <li>No messages yet.</li>}
        </ol>}
        {!readOnlyReason && <form className="thread-composer" onSubmit={sendMessage}>
          <label htmlFor="chat-message">Your message</label>
          <textarea id="chat-message" value={messageText} onChange={(event) => setMessageText(event.target.value)} maxLength="1000" required />
          <span>{messageText.length}/1000 characters. Phone numbers, email addresses, and links are blocked.</span>
          <button className="button button-primary" type="submit" disabled={sending || !messageText.trim()}>{sending ? 'Sending…' : 'Send message'}</button>
        </form>}
      </section>
    </WorkspaceFrame>
  )
}

function NotificationsWorkspace() {
  const [notifications, setNotifications] = useState([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const [all, unread] = await Promise.all([
        api.getNotifications(),
        api.getNotifications({ unreadOnly: true }),
      ])
      setNotifications(all || [])
      setUnreadCount((unread || []).length)
      setError('')
    } catch (cause) {
      setError(cause.payload?.error || cause.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(refresh, 0)
    const stopPolling = schedulePolling(refresh, POLL_INTERVALS.unread)
    return () => {
      window.clearTimeout(timer)
      stopPolling()
    }
  }, [refresh])

  async function markRead(id) {
    setError('')
    try {
      await api.markNotificationRead(id)
      setNotifications((current) => current.map((item) => item.id === id ? { ...item, is_read: true } : item))
      setUnreadCount((count) => Math.max(0, count - 1))
    } catch (cause) {
      setError(cause.payload?.error || cause.message)
    }
  }

  return (
    <WorkspaceFrame>
      <section className="customer-workspace">
        <p className="eyebrow">Updates · refreshes every 60 seconds</p><h1>Notifications</h1>
        <p aria-live="polite">{unreadCount} unread notification{unreadCount === 1 ? '' : 's'}</p>
        <ErrorMessage>{error}</ErrorMessage>
        {loading ? <p role="status">Loading notifications…</p> : notifications.length === 0
          ? <p role="status">You have no notifications yet.</p>
          : <ul className="notification-list">
            {notifications.map((item) => {
              const payload = item.payload || {}
              const conversationLink = item.event_type === 'new_message' && payload.conversationId
                ? `/inbox/${encodeURIComponent(payload.conversationId)}`
                : ''
              return <li key={item.id} className={item.is_read ? '' : 'notification-unread'}>
                <div>
                  <strong>{item.event_type.replaceAll('_', ' ')}</strong>
                  <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString()}</time>
                  {conversationLink && <a href={conversationLink}>Open conversation</a>}
                </div>
                {!item.is_read && <button className="text-button" type="button" onClick={() => markRead(item.id)}>Mark as read</button>}
              </li>
            })}
          </ul>}
      </section>
    </WorkspaceFrame>
  )
}

export default ProtectedCustomerWorkspace
