import ReviewModerationQueue from './ReviewModerationQueue.jsx'

export default function AdminReviews() {
  return (
    <section>
      <p className="admin-eyebrow">Moderation</p>
      <h1>Reviews</h1>
      <ReviewModerationQueue canRestore />
    </section>
  )
}
