const PHONE_PATTERN = /(?:^|[^\w])\+?\d[\d ().-]*\d(?:$|[^\w])/g;
const EMAIL_PATTERN = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i;
const LINK_PATTERN = /\b(?:https?:\/\/|www\.)[^\s]+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/i;

function containsContactInfo(body) {
  if (EMAIL_PATTERN.test(body) || LINK_PATTERN.test(body)) return true;
  for (const match of body.matchAll(PHONE_PATTERN)) {
    if ((match[0].match(/\d/g) || []).length >= 10) return true;
  }
  return false;
}

module.exports = { containsContactInfo };
