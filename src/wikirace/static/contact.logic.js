/* The Contact page's logic, apart from its look (contact.js), so Node can test it.
 *
 * Sending is the visitor's own email app: the form writes the message into a
 * mailto: link and opens it. Before that, a copy goes to the server
 * (POST /api/contact) in case the email is never sent. The copy is quiet: it
 * never holds the form up for long, and whatever happens to it, the email app
 * opens just the same. The visitor is not told about it.
 */

export const CONTACT_EMAIL = 'contact@JEV-Arcade.com'
export const CONTACT_PHONE = '510-560-5429'
/** The phone number as a tel: link wants it. */
export const CONTACT_TEL = '+15105605429'

export const LIMITS = { name: 200, email: 254, message: 5000 }
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/** What is wrong with the form, by field; empty when it can be sent. */
export function problems({ name = '', email = '', message = '' }) {
  const out = {}
  if (name.length > LIMITS.name) out.name = `At most ${LIMITS.name} characters.`
  if (!email.trim()) out.email = 'Your email, so we can write back.'
  else if (!EMAIL.test(email.trim()) || email.length > LIMITS.email) out.email = 'That does not look like an email address.'
  if (!message.trim()) out.message = 'What would you like to say?'
  else if (message.length > LIMITS.message) out.message = `At most ${LIMITS.message} characters.`
  return out
}

/** The mailto: link that opens the visitor's email app with everything written in. */
export function mailtoHref({ name = '', email = '', message = '' }, to = CONTACT_EMAIL) {
  const who = name.trim() ? `${name.trim()} <${email.trim()}>` : email.trim()
  const subject = name.trim() ? `JEV-Arcade: a message from ${name.trim()}` : 'JEV-Arcade: a message'
  const body = `${message.trim()}\n\n— ${who}`
  // encodeURIComponent, not URLSearchParams: a mail app reads `+` as a plus sign.
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

/**
 * Post a copy to the server, then resolve: on an answer, on a failure, or
 * after `timeoutMs`, whichever comes first. Never rejects.
 */
export function saveCopy(fields, { fetchImpl = globalThis.fetch, timeoutMs = 1500, trap = '' } = {}) {
  return new Promise((resolve) => {
    const done = () => resolve()
    const timer = setTimeout(done, timeoutMs)
    try {
      fetchImpl('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: fields.name?.trim() ?? '',
          email: fields.email?.trim() ?? '',
          message: fields.message ?? '',
          cabinet_code: trap,
        }),
        // Lets the request finish even as the mail app takes the page's focus.
        keepalive: true,
      }).then(
        () => { clearTimeout(timer); done() },
        () => { clearTimeout(timer); done() },
      )
    } catch {
      clearTimeout(timer)
      done()
    }
  })
}
