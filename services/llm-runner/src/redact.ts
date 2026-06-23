const secretPatterns = [
  /\btoken=([^\s]+)/gi,
  /\bsecret=([^\s]+)/gi,
  /\bapi[_-]?key=([^\s]+)/gi,
  /\bpassword=([^\s]+)/gi,
];

const pathPattern = /(?:\/[A-Za-z0-9._-]+){2,}/g;

export function redactText(value: string): string {
  let redacted = value;
  for (const pattern of secretPatterns) {
    redacted = redacted.replace(pattern, (match) => {
      const [key] = match.split("=");
      return `${key}=[REDACTED]`;
    });
  }

  return redacted.replace(pathPattern, "[PATH]").trim();
}
