/**
 * AI Service — Local Rule-Based Property Description Generator
 * Works 100% offline, no API key required.
 */

// ─── Phrase library ──────────────────────────────────────────────────────────

const INTROS = [
  "Discover an extraordinary opportunity in one of the city's most coveted addresses.",
  "Nestled in a prime location, this remarkable residence redefines luxury living.",
  "Welcome to an exceptional home where sophisticated design meets everyday comfort.",
  "Step into a world of refined elegance with this stunning property.",
  "Presenting a rare gem that perfectly balances modern luxury and timeless style.",
  "Experience elevated living in this meticulously crafted residence.",
  "A masterpiece of contemporary architecture awaits in this stunning property.",
  "This outstanding residence offers the ultimate in luxury lifestyle and investment value.",
  "Offering an unparalleled blend of sophistication and comfort, this residence is truly one of a kind.",
  "Situated in a highly sought-after district, this home represents the pinnacle of modern urban living.",
  "Prepare to be captivated by this exquisite residence, offering unmatched quality and style.",
  "An architectural triumph in the heart of the city, perfectly designed for modern excellence.",
  "Luxury meets lifestyle in this spectacular property, where every detail has been perfected.",
  "Welcome home to a sanctuary of elegance, boasting refined finishes and grand spaces.",
  "A prestigious residence that stands as a testament to fine design and premium craftsmanship.",
];

const ADJECTIVES = [
  "stunning", "exquisite", "premium", "sophisticated", "magnificent", "refined", 
  "exceptional", "remarkable", "breathtaking", "unmatched", "prestigious", "vibrant",
  "truly elegant", "beautifully appointed", "masterfully designed"
];

const FEATURE_PHRASES = {
  pool:      ["a resort-style swimming pool", "a stunning private pool", "a sparkling infinity pool"],
  "sea view": ["breathtaking panoramic sea views", "sweeping ocean vistas", "uninterrupted waterfront views"],
  "city view":["commanding city skyline views", "spectacular panoramic city views", "impressive urban vistas"],
  garden:    ["a beautifully landscaped private garden", "lush tropical garden grounds", "a serene private garden retreat"],
  balcony:   ["an expansive private balcony", "generous wrap-around balconies", "a grand terrace perfect for entertaining"],
  "smart home":["state-of-the-art smart home technology", "fully integrated smart home systems", "cutting-edge home automation"],
  gym:       ["a private in-unit gym", "a dedicated fitness suite", "a fully-equipped private gymnasium"],
  garage:    ["a private multi-car garage", "secure covered parking", "an oversized private garage"],
  "marble floors":["exquisite imported marble flooring", "luxurious full marble floors", "premium marble finishes throughout"],
  "open plan":["an impressive open-plan living layout", "a bright and airy open-concept design", "seamlessly flowing open-plan spaces"],
  "fully furnished":["a curated, fully furnished interior", "turnkey fully furnished living", "bespoke furniture and fittings included"],
  "maid room":["a dedicated maid's room", "separate domestic staff quarters"],
  study:     ["a private home office study", "a dedicated study and workspace"],
  terrace:   ["a sprawling rooftop terrace", "an elegant sun terrace"],
};

const BED_PHRASES = {
  studio: "a sophisticated studio layout",
  "1":    "one generously proportioned bedroom",
  "1br":  "one generously proportioned bedroom",
  "2":    "two beautifully appointed bedrooms",
  "2br":  "two beautifully appointed bedrooms",
  "3":    "three spacious bedrooms",
  "3br":  "three spacious bedrooms",
  "4":    "four expansive bedrooms",
  "4br":  "four expansive bedrooms",
  "5":    "five grand bedrooms",
  "5br":  "five grand bedrooms",
  "5+":   "five or more magnificent bedrooms",
};

const PROPERTY_TYPES = {
  villa:      "villa",
  apartment:  "apartment",
  penthouse:  "penthouse",
  townhouse:  "townhouse",
  duplex:     "duplex",
  studio:     "studio",
  loft:       "loft",
  mansion:    "mansion",
};

const PRICE_PHRASES = (price) => {
  const n = parseFloat(String(price).replace(/[^0-9.]/g, ''));
  if (!n) return "offered at a compelling price point,";
  if (n >= 5000000) return `priced at an exceptional $${fmtPrice(n)},`;
  if (n >= 1000000) return `listing at $${fmtPrice(n)},`;
  return `available at $${fmtPrice(n)},`;
};

const CLOSINGS = [
  "A rare opportunity not to be missed.",
  "An unparalleled investment in a lifestyle of distinction.",
  "Your dream home awaits — schedule a private viewing today.",
  "This is truly a home that sets the standard for luxury living.",
  "Properties of this caliber rarely come to market; act quickly.",
  "A once-in-a-generation opportunity to own an iconic residence.",
  "Experience the height of luxury for yourself; contact us for a private tour.",
  "Secure your future in one of the world's most desirable locations.",
  "Refine your lifestyle with this exceptional residential offering.",
  "A masterpiece of living that must be seen to be fully appreciated.",
  "Don't wait to claim your place in this exclusive development.",
  "The pinnacle of elite residency, now available for the discerning buyer.",
];

const AREA_PHRASES = (sqft) => {
  const n = parseFloat(String(sqft).replace(/[^0-9.]/g, ''));
  if (!n) return null;
  if (n > 10000) return `an incredible ${n.toLocaleString()} sq ft of living space`;
  if (n > 4000)  return `${n.toLocaleString()} sq ft of expansive living space`;
  if (n > 2000)  return `${n.toLocaleString()} sq ft of well-appointed space`;
  return `${n.toLocaleString()} sq ft`;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function fmtPrice(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return n.toLocaleString();
}

// ─── Main generator ──────────────────────────────────────────────────────────

const generateDescription = async (details) => {
  try {
    const text = buildDescription(details);
    return { success: true, text };
  } catch (err) {
    console.error('Local AI Error:', err.message);
    return {
      success: true,
      text: "This elegantly appointed residence offers an exceptional lifestyle opportunity, combining premium finishes with thoughtful design across every room. Ideally situated in one of the city's most prestigious addresses, this property delivers both comfort and sophistication at every turn. A rare chance to own a home that truly sets the standard for luxury living.",
    };
  }
};

function buildDescription(details) {
  const d = details.toLowerCase();

  // ── Extract property type
  let propType = 'property';
  for (const [key, label] of Object.entries(PROPERTY_TYPES)) {
    if (d.includes(key)) { propType = label; break; }
  }

  // ── Extract bedrooms
  let bedPhrase = null;
  for (const [key, phrase] of Object.entries(BED_PHRASES)) {
    // match "3br", "3 br", "3 bed", "3 bedrooms", "3bhk", "3 bhk"
    const pattern = new RegExp(`\\b${key}[\\s-]?(?:br|bed(?:room)?s?|bhk)\\b`, 'i');
    if (pattern.test(d)) {
      bedPhrase = phrase; break;
    }
  }

  // ── Extract area (sqft/sqm/sqrf)
  const areaMatch = d.match(/(\d[\d,]*)\s*(?:sq\.?\s*ft|sqft|sq\.?\s*m|sqm|m²|ft²|sqrf)/i);
  const areaPhrase = areaMatch ? AREA_PHRASES(areaMatch[1]) : null;

  // ── Extract location
  let location = null;
  const locMatch = d.match(/(?:located\s+in|in|at)\s+([^,.\n?!(]+)/i);
  if (locMatch) {
    location = locMatch[1].trim()
      .split(/\s+/)
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  // ── Extract price
  const priceMatch = d.match(/\$\s*([\d,.]+\s*[mk]?)/i) || d.match(/([\d,.]+\s*(?:million|m|k))/i);
  const pricePhrase = priceMatch ? PRICE_PHRASES(priceMatch[0]) : null;

  // ── Extract features
  const featuresFound = [];
  for (const [key, phrases] of Object.entries(FEATURE_PHRASES)) {
    if (d.includes(key)) featuresFound.push(pick(phrases));
  }

  // ── Build sentence 1: intro
  let s1 = pick(INTROS);
  if (location) {
    const locIntros = [
      `Discover an extraordinary opportunity in the heart of ${location}.`,
      `Nestled in the prestigious ${location} area, this remarkable residence redefines luxury living.`,
      `Welcome to an exceptional home in ${location} where sophisticated design meets everyday comfort.`,
      `Experience elevated living in this meticulously crafted residence located in ${location}.`,
    ];
    s1 = Math.random() > 0.3 ? pick(locIntros) : s1 + ` Ideally located in ${location}.`;
  }

  // ── Build sentence 2: key property details
  const parts = [];
  if (bedPhrase) parts.push(bedPhrase);
  if (areaPhrase) parts.push(areaPhrase);
  const s2parts = parts.length
    ? `Boasting ${parts.join(' and ')}, this ${propType} has been curated for the most discerning residents.`
    : `This exceptional ${propType} has been finished to an international standard of luxury.`;

  // ── Build sentence 3: standout features
  let s3;
  if (featuresFound.length >= 2) {
    const f1 = featuresFound[0];
    const f2 = featuresFound[1];
    s3 = `Residents will enjoy ${f1} and ${f2}, elevating the living experience to new heights.`;
  } else if (featuresFound.length === 1) {
    s3 = `The home features ${featuresFound[0]}, ensuring an unmatched level of comfort and style.`;
  } else {
    s3 = "Premium finishes, high-end appliances, and meticulous attention to detail define every corner of this residence.";
  }

  // ── Add pricing sentence if available
  let s4 = '';
  if (pricePhrase) {
    s4 = ` The property is ${pricePhrase} representing superb value in today's luxury market.`;
  }

  // ── Closing
  const s5 = pick(CLOSINGS);

  return `${s1} ${s2parts} ${s3}${s4} ${s5}`;
}

module.exports = { generateDescription };
