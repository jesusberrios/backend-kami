const absoluteUrl = (baseUrl, value) => {
    if (!value) return '';
    try {
        return new URL(value, baseUrl).toString();
    } catch {
        return String(value);
    }
};

module.exports = { absoluteUrl };
