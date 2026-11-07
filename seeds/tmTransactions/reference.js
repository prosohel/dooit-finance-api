// seeds/tmTransactions/reference.js
//
// Static reference data for the transaction-monitoring seed: the home
// institution, counterparty banks by corridor, name pools and narratives.
//
// Two conventions matter here:
//
//   1. Values a monitoring rule compares against are written exactly as the
//      rule corpus spells them (UNKNOWN, GAMBLING, MIXER, CASH, WIRE …), so a
//      case-sensitive evaluator matches them as well as a tolerant one.
//
//   2. BASELINE_NARRATIVES deliberately avoid the words the rule corpus keys
//      on (cash, invoice, services, consult, gift, loan, crypto, exchange,
//      unknown, test, sample). Ordinary traffic must not trip keyword rules by
//      accident — only the typologies that mean to use those words do.

const SOURCE = "seedTmTransactions";
// Marker inside every uid this seed creates. It must NOT contain "SEED":
// seedCaseWorkflow's --clean deletes every row whose uid matches /SEED/.
const MARK = "TMDEMO";
const RELATION_SOURCE = "tm-seed";

const DEFAULT_CLIENT = "6a716afc2544b240f81a7dba"; // Prime Bank PLC

const HOME = {
  country: "Bangladesh",
  currency: "BDT",
  bic: "PRBLBDDH",
  timezone: "Asia/Dhaka",
  utcOffsetMs: 6 * 3600e3,
};

// Units of AUD per one unit of currency. BDT matches the rate implied by the
// monitoring API's own sample record (27,840.70 BDT → 356.93 AUD).
const FX_TO_AUD = {
  BDT: 0.012821,
  USD: 1.52,
  EUR: 1.65,
  GBP: 1.93,
  AED: 0.414,
  SAR: 0.405,
  MYR: 0.343,
  SGD: 1.14,
  AUD: 1,
};

const DOMESTIC_BANKS = [
  { institution: "BRAC Bank", bic: "BRAKBDDH" },
  { institution: "Eastern Bank", bic: "EBLDBDDH" },
  { institution: "Dutch-Bangla Bank", bic: "DBBLBDDH" },
  { institution: "Islami Bank Bangladesh", bic: "IBBLBDDH" },
  { institution: "Sonali Bank", bic: "BSONBDDH" },
  { institution: "The City Bank", bic: "CIBLBDDH" },
  { institution: "Mutual Trust Bank", bic: "MTBLBDDH" },
  { institution: "Standard Chartered Bangladesh", bic: "SCBLBDDX" },
  { institution: "Pubali Bank", bic: "PUBABDDH" },
  { institution: "Janata Bank", bic: "JANBBDDH" },
];

const MFS_PROVIDERS = ["bKash", "Nagad", "Rocket"];

// Foreign counterparty banks, grouped by the corridor a typology draws from.
const FOREIGN_BANKS = {
  gulf: [
    { institution: "Emirates NBD", country: "United Arab Emirates", bic: "EBILAEAD", currency: "AED" },
    { institution: "Al Rajhi Bank", country: "Saudi Arabia", bic: "RJHISARI", currency: "SAR" },
    { institution: "Qatar National Bank", country: "Qatar", bic: "QNBAQAQA", currency: "USD" },
    { institution: "National Bank of Kuwait", country: "Kuwait", bic: "NBOKKWKW", currency: "USD" },
    { institution: "Bank Muscat", country: "Oman", bic: "BMUSOMRX", currency: "USD" },
  ],
  asia: [
    { institution: "Maybank", country: "Malaysia", bic: "MBBEMYKL", currency: "MYR" },
    { institution: "DBS Bank", country: "Singapore", bic: "DBSSSGSG", currency: "SGD" },
    { institution: "State Bank of India", country: "India", bic: "SBININBB", currency: "USD" },
    { institution: "HSBC Hong Kong", country: "Hong Kong", bic: "HSBCHKHH", currency: "USD" },
  ],
  west: [
    { institution: "Barclays Bank", country: "United Kingdom", bic: "BARCGB22", currency: "GBP" },
    { institution: "JPMorgan Chase Bank", country: "United States", bic: "CHASUS33", currency: "USD" },
    { institution: "Commonwealth Bank of Australia", country: "Australia", bic: "CTBAAU2S", currency: "AUD" },
    { institution: "UniCredit", country: "Italy", bic: "UNCRITMM", currency: "EUR" },
  ],
  highRisk: [
    { institution: "Myanma Foreign Trade Bank", country: "Myanmar", bic: "MFTBMMMY", currency: "USD" },
    { institution: "Da Afghanistan Bank", country: "Afghanistan", bic: "DABAAFKA", currency: "USD" },
    { institution: "Yemen Kuwait Bank", country: "Yemen", bic: "YKBAYESA", currency: "USD" },
    { institution: "Banque du Liban et d'Outre-Mer", country: "Lebanon", bic: "BLOMLBBX", currency: "USD" },
  ],
  sanctioned: [
    { institution: "Bank Melli Iran", country: "Iran", bic: "MELIIRTH", currency: "EUR" },
    { institution: "Foreign Trade Bank of the DPRK", country: "North Korea", bic: null, currency: "EUR" },
    { institution: "Commercial Bank of Syria", country: "Syria", bic: "CMSYSYDA", currency: "EUR" },
  ],
  // Fictional institutions. "Offshore" in the name is what rules R69/R70 match.
  offshore: [
    { institution: "Cayman Reef Offshore Bank", country: "Cayman Islands", bic: null, currency: "USD" },
    { institution: "Tortola Offshore Trust Bank", country: "British Virgin Islands", bic: null, currency: "USD" },
    { institution: "Banco Offshore del Istmo", country: "Panama", bic: null, currency: "USD" },
    { institution: "Mahe Offshore Commercial Bank", country: "Seychelles", bic: null, currency: "USD" },
    { institution: "Port Vila Offshore Banking Corp", country: "Vanuatu", bic: null, currency: "USD" },
  ],
  tradeHub: [
    { institution: "Emirates NBD", country: "United Arab Emirates", bic: "EBILAEAD", currency: "USD" },
    { institution: "HSBC Hong Kong", country: "Hong Kong", bic: "HSBCHKHH", currency: "USD" },
    { institution: "DBS Bank", country: "Singapore", bic: "DBSSSGSG", currency: "USD" },
    { institution: "Bank of China", country: "China", bic: "BKCHCNBJ", currency: "USD" },
  ],
};

const CORRESPONDENTS = [
  { name: "JPMorgan Chase Bank NA", institution: "JPMorgan Chase Bank", institutionCountry: "United States", bic: "CHASUS33", account: "CHASUS33" },
  { name: "Standard Chartered Bank New York", institution: "Standard Chartered Bank", institutionCountry: "United States", bic: "SCBLUS33", account: "SCBLUS33" },
  { name: "Mashreq Bank PSC", institution: "Mashreq Bank", institutionCountry: "United Arab Emirates", bic: "BOMLAEAD", account: "BOMLAEAD" },
];

// ── People and businesses (all fictional) ───────────────────────────────────

const GIVEN_NAMES = [
  "Abdul", "Aminul", "Anisur", "Arif", "Ashraful", "Faisal", "Farhan", "Habibur", "Imran", "Jahid",
  "Kamrul", "Mahbub", "Mamun", "Masud", "Mizanur", "Monir", "Nazmul", "Rafiq", "Rakib", "Rashed",
  "Saiful", "Shafiq", "Shahin", "Sohag", "Tanvir", "Tariq", "Zahid", "Zakir",
  "Afsana", "Ayesha", "Farzana", "Fatema", "Jannat", "Laila", "Mahmuda", "Nasrin", "Nusrat", "Rehana",
  "Rokeya", "Sabina", "Sadia", "Salma", "Shamima", "Sharmin", "Sultana", "Taslima", "Tahmina", "Umme",
];

const SURNAMES = [
  "Ahmed", "Akter", "Alam", "Ali", "Amin", "Aziz", "Babu", "Barua", "Begum", "Biswas",
  "Chowdhury", "Das", "Haque", "Hasan", "Hossain", "Islam", "Kabir", "Karim", "Khan", "Khatun",
  "Mahmud", "Miah", "Mollah", "Mondal", "Rahman", "Roy", "Saha", "Sarkar", "Sheikh", "Siddique",
  "Sikder", "Talukder", "Uddin",
];

const FOREIGN_PERSONS = {
  gulf: ["Khalid Al Mansoori", "Yousef Al Harbi", "Abdullah Al Thani", "Saeed Al Kuwari", "Hamad Al Balushi", "Rashid Al Nuaimi", "Faisal Al Otaibi", "Omar Al Shamsi"],
  asia: ["Tan Wei Ming", "Lim Chee Keong", "Rajesh Kumar", "Wong Ka Ho", "Siti Aminah", "Arjun Mehta", "Chan Siu Fai", "Nur Hidayah"],
  west: ["James Whitaker", "Sarah Collins", "Michael Brennan", "Emma Hughes", "Luca Ferrari", "Olivia Turner", "Daniel Reid", "Giulia Conti"],
  highRisk: ["Aung Min Htet", "Farid Noorzai", "Saleh Al Hadrami", "Karim Haddad", "Zaw Lin Oo", "Najib Rahimi"],
  sanctioned: ["Reza Karimi", "Hossein Moradi", "Kim Chol Su", "Samer Al Khatib", "Ali Rezaei", "Pak Yong Nam"],
};

const DOMESTIC_BUSINESSES = [
  "Meghna Agro Industries", "Rupsha Traders", "Padma Textile Mills", "Jamuna Steel Works", "Karnaphuli Shipping Lines",
  "Surma Tea Estate", "Teesta Packaging", "Buriganga Logistics", "Sundarban Fisheries", "Dhaleshwari Garments",
  "Kushiara Plastics", "Bengal Leather Complex", "Chattala Hardware Mart", "Sonargaon Pharma Distributors", "Mohona Electronics",
  "Shapla Printing House", "Kirtonkhola Rice Mills", "Titas Building Materials", "Gorai Poultry Farms", "Halda Cold Storage",
];

// Counterparties with no visible business — the receiving end of a typology.
const SHELL_COMPANIES = [
  "Blue Harbor Holdings Ltd", "Zenith Global Trading FZE", "Orchid Bay Consultants Inc", "Silverline Ventures Ltd",
  "Northgate Commodities DMCC", "Pacific Crest Enterprises Ltd", "Redwood Meridian Corp", "Ivory Coast Line Trading LLC",
  "Sable Point Investments SA", "Golden Vertex General Trading", "Astral Bridge Holdings Inc", "Kestrel Bay Partners Ltd",
];

const BETTING_OPERATORS = [
  { name: "LuckyStrike Gaming N.V.", institution: "Curacao Gaming Settlement Bank", country: "Curacao" },
  { name: "BetNova Sports Ltd", institution: "Valletta Merchant Bank", country: "Malta" },
  { name: "RoyalAce Online Casino", institution: "Curacao Gaming Settlement Bank", country: "Curacao" },
];

// "New" / "Shell" in the name is what the travel-rule rules R107–R112 match.
const VASPS = [
  { id: "VASP-SC-0091", name: "New Horizon Digital Assets Ltd", country: "Seychelles" },
  { id: "VASP-EE-0417", name: "Shell Harbor Digital OU", country: "Estonia" },
  { id: "VASP-KY-0233", name: "BitNova Global Exchange", country: "Cayman Islands" },
  { id: "VASP-test-0007", name: "Tether Bridge Pte", country: "Singapore" },
  { id: "VASP-AE-0560", name: "Dune Crypto Markets FZE", country: "United Arab Emirates" },
];

const WATCHLIST_NAMES = ["Viktor Draganov", "Nasser Al Fayed", "Li Zhong Wei", "Tariq Mahmood Qureshi", "Sergei Volkov", "Ibrahim Sesay"];

const BILLERS = ["DESCO", "DPDC", "Titas Gas", "Dhaka WASA", "Grameenphone", "Robi Axiata", "Banglalink", "BTCL"];
const MERCHANTS = ["Shwapno", "Agora", "Aarong", "Daraz Bangladesh", "Foodpanda", "Pathao", "Chaldal", "Meena Bazar", "Star Kabab", "Bata Shoe"];
const BROKERAGES = ["LankaBangla Securities", "IDLC Securities", "BRAC EPL Stock Brokerage", "City Brokerage"];

const LOCATIONS = [
  { district: "Dhaka", areas: ["Dhanmondi", "Gulshan", "Banani", "Mirpur", "Uttara", "Motijheel", "Mohammadpur"], postcode: "1209" },
  { district: "Chattogram", areas: ["Agrabad", "Nasirabad", "Halishahar", "Pahartali"], postcode: "4100" },
  { district: "Sylhet", areas: ["Zindabazar", "Amberkhana", "Shibganj"], postcode: "3100" },
  { district: "Khulna", areas: ["Sonadanga", "Khalishpur", "Boyra"], postcode: "9100" },
  { district: "Rajshahi", areas: ["Shaheb Bazar", "Uposhohor", "Kazla"], postcode: "6000" },
  { district: "Cumilla", areas: ["Kandirpar", "Jhawtala", "Tomsom Bridge"], postcode: "3500" },
  { district: "Gazipur", areas: ["Tongi", "Joydebpur", "Board Bazar"], postcode: "1700" },
  { district: "Narayanganj", areas: ["Chashara", "Fatullah", "Siddhirganj"], postcode: "1400" },
];

const OCCUPATIONS = {
  retail: [
    ["Private Service", "Garments"], ["Teacher", "Education"], ["Doctor", "Healthcare"], ["Engineer", "Construction"],
    ["Government Officer", "Public Administration"], ["Banker", "Banking"], ["Pharmacist", "Healthcare"],
    ["Software Developer", "Technology"], ["Nurse", "Healthcare"], ["Accountant", "Professional Firms"],
    ["Merchandiser", "Garments"], ["Driver", "Transport"],
  ],
  sme: [
    ["Shop Owner", "Retail Trade"], ["Wholesaler", "Wholesale Trade"], ["Restaurant Owner", "Hospitality"],
    ["Contractor", "Construction"], ["Garment Supplier", "Garments"], ["Pharmacy Owner", "Healthcare"],
    ["Transport Operator", "Transport"], ["Agro Trader", "Agriculture"],
  ],
  hnw: [
    ["Company Director", "Manufacturing"], ["Industrialist", "Textiles"], ["Property Developer", "Construction"],
    ["Managing Partner", "Professional Firms"], ["Ship Owner", "Shipping"],
  ],
};

// Industry constants the Entity Risk rules compare against (R129–R138).
const RISK_INDUSTRIES = ["CRYPTO", "GAMBLING", "NGO", "CASH_INTENSIVE", "MINING", "IMPORT_EXPORT", "REAL_ESTATE", "JEWELRY", "MSB", "FOREX"];

const SOURCES_OF_FUNDS = {
  retail: ["Salary", "Salary", "Savings", "Pension", "Rental Income"],
  sme: ["Business Income", "Business Income", "Trading Income"],
  hnw: ["Business Income", "Investment Income", "Rental Income"],
  student: ["Family Support", "Remittance", "Scholarship"],
};

const BASELINE_NARRATIVES = {
  p2p: ["Fund transfer", "Family support", "Monthly rent", "School fees", "Shared expenses", "Reimbursement", "Medical expenses"],
  bill: ["Electricity bill", "Gas bill", "Water bill", "Mobile recharge", "Internet bill", "Postpaid bill"],
  merchant: ["Grocery purchase", "Retail purchase", "Food order", "Ride fare", "Online order"],
  atm: ["ATM withdrawal"],
  deposit: ["Counter deposit", "Deposit by account holder"],
  takings: ["Counter deposit - daily takings", "Counter deposit - sales proceeds"],
  salary: ["Salary credit", "Monthly salary"],
  supplier: ["Supplier settlement", "Payment for goods", "Raw material purchase", "Stock replenishment"],
  receipt: ["Customer payment", "Order settlement", "Sales proceeds"],
  payroll: ["Staff salary", "Wages"],
  invest: ["Brokerage funding", "Share purchase", "DPS instalment", "Sanchaypatra purchase"],
  remitIn: ["Family maintenance", "Inward remittance", "Family support from abroad"],
  remitOut: ["Tuition fees", "Medical treatment abroad", "Travel expenses"],
  fx: ["Travel quota endorsement"],
};

module.exports = {
  SOURCE,
  MARK,
  RELATION_SOURCE,
  DEFAULT_CLIENT,
  HOME,
  FX_TO_AUD,
  DOMESTIC_BANKS,
  MFS_PROVIDERS,
  FOREIGN_BANKS,
  CORRESPONDENTS,
  GIVEN_NAMES,
  SURNAMES,
  FOREIGN_PERSONS,
  DOMESTIC_BUSINESSES,
  SHELL_COMPANIES,
  BETTING_OPERATORS,
  VASPS,
  WATCHLIST_NAMES,
  BILLERS,
  MERCHANTS,
  BROKERAGES,
  LOCATIONS,
  OCCUPATIONS,
  RISK_INDUSTRIES,
  SOURCES_OF_FUNDS,
  BASELINE_NARRATIVES,
};
