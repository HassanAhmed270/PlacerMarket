import { useEffect } from 'react'

const PAGES = Object.freeze({
  about: {
    title: 'About',
    copy: 'Poshaak is a marketplace for discovering and listing pre-loved, custom-made, and new clothing.',
  },
  'how-it-works': {
    title: 'How it works',
    copy: 'Browse published listings, review the item details, and contact the seller through Poshaak messaging.',
  },
  terms: {
    title: 'Terms',
    copy: 'The terms for using Poshaak are being prepared. This draft is not the final legal text.',
  },
  privacy: {
    title: 'Privacy',
    copy: 'The privacy information for Poshaak is being prepared. This draft is not the final privacy notice.',
  },
  help: {
    title: 'Help',
    copy: 'Help information is being prepared. For now, use the available account and listing tools on the site.',
  },
  contact: {
    title: 'Contact',
    copy: 'Contact information is being prepared. Please do not include phone numbers, email addresses, or external links in marketplace messages.',
  },
})

function StaticPage({ page }) {
  const content = PAGES[page]

  useEffect(() => {
    const previousTitle = document.title
    const robots = document.querySelector('meta[name="robots"]')
    const previousRobots = robots?.getAttribute('content')
    const meta = robots || document.createElement('meta')
    if (!robots) {
      meta.name = 'robots'
      document.head.append(meta)
    }
    document.title = `${content.title} · Poshaak`
    meta.content = 'noindex,follow'
    return () => {
      document.title = previousTitle
      if (robots) {
        if (previousRobots === null) robots.removeAttribute('content')
        else robots.content = previousRobots
      } else {
        meta.remove()
      }
    }
  }, [content.title])

  return (
    <main className="static-page">
      <p className="eyebrow">Poshaak marketplace</p>
      <div className="draft-marking" role="note">Draft · Not final</div>
      <h1>{content.title}</h1>
      <p>{content.copy}</p>
      <p className="form-hint">This page is a draft and will be updated before launch.</p>
      <a className="button button-secondary" href="/">Return to Poshaak</a>
    </main>
  )
}

export default StaticPage
