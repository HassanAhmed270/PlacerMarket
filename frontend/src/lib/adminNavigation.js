export function visibleAdminLinks(role) {
  const adminLinks = [
    { href: '/admin/orders', label: 'Orders' },
    { href: '/admin/exceptions', label: 'Exceptions' },
    { href: '/admin/disputes', label: 'Disputes' },
    { href: '/admin/refunds', label: 'Refunds' },
    { href: '/admin/seller-payouts', label: 'Seller payouts' },
    { href: '/admin/held-funds', label: 'Held funds' },
    { href: '/admin/payout-settings', label: 'Payout settings' },
    { href: '/admin/delivery-cities', label: 'Delivery cities' },
    { href: '/admin/reviews', label: 'Reviews' },
    { href: '/admin/returns', label: 'Returns' },
    { href: '/admin/chargebacks', label: 'Chargebacks' },
    { href: '/admin/consistency', label: 'Consistency' },
  ]
  if (role === 'admin') return adminLinks
  if (role === 'moderator') return adminLinks.filter((link) => link.href === '/admin/disputes')
  return []
}
