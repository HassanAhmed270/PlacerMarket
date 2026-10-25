import { useEffect, useState } from 'react'
import { api } from './lib/api.js'

function HomePage() {
  const [categories, setCategories] = useState([])
  const [categoryState, setCategoryState] = useState('loading')

  useEffect(() => {
    let active = true
    api.getMainCategories()
      .then((result) => {
        if (!active) return
        setCategories(Array.isArray(result) ? result : [])
        setCategoryState('ready')
      })
      .catch(() => {
        if (active) setCategoryState('unavailable')
      })

    return () => { active = false }
  }, [])

  return (
    <main id="top">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow"><span /> The Poshaak marketplace</p>
          <h1 id="hero-title">Find something lovely to wear.</h1>
          <p className="hero-description">
            Discover distinctive pre-loved fashion from sellers across Pakistan.
          </p>
          <a className="button button-primary" href="#categories">
            Explore categories <span aria-hidden="true">↗</span>
          </a>
          <p className="preview-note">Thoughtful finds, shared with care</p>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="art-orbit orbit-one" />
          <div className="art-orbit orbit-two" />
          <div className="art-card">
            <span className="art-card-label">Poshaak edit</span>
            <span className="art-card-flower">✳</span>
            <span className="art-card-caption">A marketplace for style with a story</span>
          </div>
          <span className="art-spark spark-one">✦</span>
          <span className="art-spark spark-two">✧</span>
        </div>
      </section>

      <section className="category-section" id="categories" aria-labelledby="categories-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Start somewhere lovely</p>
            <h2 id="categories-title">Explore categories</h2>
          </div>
          <span className="section-index">01 / Browse</span>
        </div>
        {categoryState === 'loading' && <p className="category-message" role="status">Loading categories…</p>}
        {categoryState === 'unavailable' && (
          <p className="category-message" role="status">
            Categories will appear here when the catalog is available.
          </p>
        )}
        {categoryState === 'ready' && categories.length === 0 && (
          <p className="category-message" role="status">No categories are available yet.</p>
        )}
        {categoryState === 'ready' && categories.length > 0 && (
          <ul className="category-list">
            {categories.map((category, index) => (
              <li className="category-card" key={category.id}>
                <span className="category-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <span>{category.name}</span>
                <span className="category-arrow" aria-hidden="true">↗</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="about-section" id="about" aria-labelledby="about-title">
        <p className="eyebrow">Made for discovery</p>
        <h2 id="about-title">Style finds a second story.</h2>
        <p>Sign in to create listings and manage your seller workspace.</p>
        <a className="button button-secondary" href="/register">Join Poshaak</a>
      </section>
    </main>
  )
}

export default HomePage
