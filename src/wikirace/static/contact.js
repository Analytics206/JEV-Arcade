/* The Contact page (?tab=contact): how to reach us, and a form that opens the
 * visitor's email app with their message written in (contact.logic.js says how). */
import { h } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import htm from 'htm'
import { SiteFooter, SiteHeader } from './brand.js'
import { CONTACT_EMAIL, CONTACT_PHONE, CONTACT_TEL, LIMITS, mailtoHref, problems, saveCopy } from './contact.logic.js'
import { sfx } from './sfx.js'

const html = htm.bind(h)

function Field({ id, label, error, children }) {
  return html`
    <div class=${`ct-field${error ? ' is-bad' : ''}`}>
      <label class="ct-label" for=${id}>${label}</label>
      ${children}
      ${error && html`<p class="ct-err" id=${`${id}-err`}>${error}</p>`}
    </div>
  `
}

function ContactForm() {
  const [fields, setFields] = useState({ name: '', email: '', message: '' })
  const [trap, setTrap] = useState('')
  const [errors, setErrors] = useState({})
  const [state, setState] = useState('idle') // idle | opening | opened
  const set = (k) => (e) => setFields((f) => ({ ...f, [k]: e.currentTarget.value }))

  const submit = async (e) => {
    e.preventDefault()
    const found = problems(fields)
    setErrors(found)
    if (Object.keys(found).length) return
    setState('opening')
    sfx.select()
    // A copy first, quietly and briefly; then the email app, whatever the copy did.
    await saveCopy(fields, { trap })
    location.href = mailtoHref(fields)
    setState('opened')
  }

  const err = (k) => (errors[k] ? `ct-${k}-err` : undefined)
  return html`
    <form class="ct-form panel" onSubmit=${submit} noValidate>
      <div class="panel__hd"><span class="panel__title">Write to us</span></div>
      <div class="panel__bd ct-form__bd">
        <${Field} id="ct-name" label="Your name" error=${errors.name}>
          <input id="ct-name" class="wr-in ct-in" type="text" autocomplete="name" maxLength=${LIMITS.name}
            value=${fields.name} onInput=${set('name')} aria-describedby=${err('name')} />
        <//>
        <${Field} id="ct-email" label="Your email" error=${errors.email}>
          <input id="ct-email" class="wr-in ct-in" type="email" autocomplete="email" required maxLength=${LIMITS.email}
            value=${fields.email} onInput=${set('email')} aria-invalid=${errors.email ? 'true' : undefined}
            aria-describedby=${err('email')} />
        <//>
        <${Field} id="ct-message" label="Message" error=${errors.message}>
          <textarea id="ct-message" class="wr-in ct-in ct-msg" rows="7" required maxLength=${LIMITS.message}
            value=${fields.message} onInput=${set('message')} aria-invalid=${errors.message ? 'true' : undefined}
            aria-describedby=${err('message')}></textarea>
        <//>
        <div class="ct-trap" aria-hidden="true">
          <label for="ct-cabinet">Leave this empty</label>
          <input id="ct-cabinet" type="text" name="cabinet_code" tabIndex="-1" autocomplete="off"
            value=${trap} onInput=${(e) => setTrap(e.currentTarget.value)} />
        </div>
        <div class="ct-send">
          <button type="submit" class="btn btn--primary" disabled=${state === 'opening'}>
            ${state === 'opening' ? 'Opening your email app…' : 'Open in my email app'}
          </button>
          <p class="ct-hint">Your email app opens with this message ready. Press send there.</p>
        </div>
        ${state === 'opened' &&
        html`
          <p class="ct-done" role="status">
            Your email app should now have your message, ready to send. Nothing opened? Write to
            <a href=${`mailto:${CONTACT_EMAIL}`}>${CONTACT_EMAIL}</a> from any email account.
          </p>
        `}
      </div>
    </form>
  `
}

export function Contact() {
  // As site.py names this view for search engines.
  useEffect(() => {
    document.title = 'Contact · JEV-Arcade'
  }, [])
  return html`
    <div class="app">
      <${SiteHeader} active="contact" crumb="Contact" />
      <main class="g-main scroll-y ct">
        <div class="ct__in">
          <section class="ct-intro">
            <h1 class="ct-h">Contact</h1>
            <p class="ct-lede">Questions, ideas for a cabinet, or a race worth talking about: we read every message.</p>
            <dl class="ct-ways">
              <div class="ct-way">
                <dt>Email</dt>
                <dd><a href=${`mailto:${CONTACT_EMAIL}`}>${CONTACT_EMAIL}</a></dd>
              </div>
              <div class="ct-way">
                <dt>Phone</dt>
                <dd><a href=${`tel:${CONTACT_TEL}`}>${CONTACT_PHONE}</a></dd>
              </div>
            </dl>
          </section>
          <${ContactForm} />
        </div>
        <${SiteFooter} />
      </main>
    </div>
  `
}
