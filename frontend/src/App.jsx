import { useEffect, useState } from 'react'
import { api } from './lib/api.js'
import './App.css'

function App() {
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

    return () => {
      active = false
    }
  }, [])

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="wordmark" href="#top" aria-label="Poshaak home">
          <span className="wordmark-mark" aria-hidden="true">P</span>
          <span>Poshaak</span>
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          <a href="#categories">Explore</a>
          <a href="#about">About</a>
          <a className="nav-sell" href="#seller-note">Sell with us</a>
        </nav>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow"><span /> The Poshaak marketplace</p>
              <h1 id="hero-title">Your website workspace is ready.</h1>
            <p className="hero-description">
              This responsive preview is connected to the public catalog API and ready for continued UI development.
            </p>
            <a className="button button-primary" href="#categories">
              Explore categories <span aria-hidden="true">↗</span>
            </a>
            <p className="preview-note">Website preview · browsing foundation</p>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-orbit orbit-one" />
            <div className="art-orbit orbit-two" />
            <div className="art-card">
            <span className="art-card-label">Frontend preview</span>
              <span className="art-card-flower">✳</span>
            <span className="art-card-caption">Browse interface foundation</span>
            </div>
            <span className="art-spark spark-one">✦</span>
            <span className="art-spark spark-two">✧</span>
          </div>
        </section>

        <section className="category-section" id="categories" aria-labelledby="categories-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Start somewhere lovely</p>
              <h2 id="categories-title">Public catalog</h2>
            </div>
            <span className="section-index">01 / Browse</span>
          </div>

          {categoryState === 'loading' && (
            <p className="category-message" role="status">Loading categories…</p>
          )}
          {categoryState === 'unavailable' && (
            <p className="category-message" role="status">
              Categories will appear here when the development API is available.
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
          <h2 id="about-title">Development preview</h2>
          <p>Browse is being connected to the marketplace API. This preview does not provide sign-in or seller tools.</p>
        </section>

        <p className="seller-note" id="seller-note">
          Seller and account features will be available when the secure sign-in flow is ready.
        </p>
      </main>

      <footer className="site-footer">
        <a className="wordmark footer-wordmark" href="#top">Poshaak</a>
        <span>Frontend foundation</span>
      </footer>
    </div>
  )
}

export default App
