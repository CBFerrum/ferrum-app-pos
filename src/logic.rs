//! The register's money rules, free of I/O so each one is tested on its own: which tenders
//! settle a sale (change only out of cash, small shortfalls written off), what a return may
//! refund and how, loyalty points, cash counts, and consolidation lines that add up exactly.

use rust_decimal::prelude::ToPrimitive;
use rust_decimal::{Decimal, RoundingStrategy};

/// How a mode of payment behaves (`ModeOfPayment.mode_type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Cash,
    Bank,
    General,
    Credit,
    Loyalty,
    /// A gift card, store credit or other stored value (ERP's `StoredValueKind`).
    StoredValue,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        Some(match s {
            "Cash" => Kind::Cash,
            "Bank" => Kind::Bank,
            "General" => Kind::General,
            "Credit" => Kind::Credit,
            "Loyalty Points" => Kind::Loyalty,
            "Stored Value" => Kind::StoredValue,
            _ => return None,
        })
    }

    /// Settled into a money account (drawer, bank or clearing account), so counted at closing.
    pub fn is_money(self) -> bool {
        matches!(self, Kind::Cash | Kind::Bank | Kind::General)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Tender {
    pub kind: Kind,
    pub amount: Decimal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Settlement {
    pub paid: Decimal,
    pub change: Decimal,
    pub write_off: Decimal,
}

/// Settles a sale of `total`: the tenders must cover it (a shortfall up to `write_off_limit` is
/// written off), and only cash can be overpaid, the excess going back as change.
pub fn settle_sale(total: Decimal, tenders: &[Tender], write_off_limit: Decimal) -> Result<Settlement, String> {
    if let Some(t) = tenders.iter().find(|t| t.amount <= Decimal::ZERO) {
        return Err(format!("payment amounts must be positive (got {})", t.amount.normalize()));
    }
    let paid: Decimal = tenders.iter().map(|t| t.amount).sum();
    if paid < total {
        let short = total - paid;
        if short <= write_off_limit {
            return Ok(Settlement { paid, change: Decimal::ZERO, write_off: short });
        }
        return Err(format!("insufficient payment: {} received of {} due", paid.normalize(), total.normalize()));
    }
    let non_cash: Decimal = tenders.iter().filter(|t| t.kind != Kind::Cash).map(|t| t.amount).sum();
    if non_cash > total {
        return Err(format!("only cash can be overpaid: non-cash payments of {} exceed the {} due", non_cash.normalize(), total.normalize()));
    }
    Ok(Settlement { paid, change: paid - total, write_off: Decimal::ZERO })
}

/// Takes the change handed back out of an invoice's cash tenders, in order, so each payment
/// method shows what it really brought in (100 cash for a 92.50 bill counts 92.50).
pub fn net_of_change(change: Decimal, tenders: &mut [Tender]) {
    let mut left = change.max(Decimal::ZERO);
    for t in tenders.iter_mut().filter(|t| t.kind == Kind::Cash && t.amount > Decimal::ZERO) {
        let take = left.min(t.amount);
        t.amount -= take;
        left -= take;
    }
}

/// What an original sale can still pay back, per class (positive amounts): what it was paid
/// with, less what earlier returns refunded that way.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Refundable {
    /// Cash, cards and other money tenders, net of change.
    pub money: Decimal,
    /// Still owed on account.
    pub credit: Decimal,
    /// Paid with loyalty points (their value).
    pub loyalty: Decimal,
    /// Paid with stored value: it goes back onto stored value, never out as money.
    pub stored: Decimal,
}

/// What a sale can still pay back, from what it took in and what its returns refunded so far,
/// per class: `taken` is `(kind, paid net of the change given, refunded so far)` for each payment
/// method used. A shortfall the register wrote off counts as money taken, since a return refunds
/// the whole bill; otherwise the last item of a sale paid a little short could never come back.
pub fn refundable(taken: &[(Kind, Decimal, Decimal)], write_off: Decimal) -> Refundable {
    let mut left = Refundable { money: write_off.max(Decimal::ZERO), ..Default::default() };
    for (kind, paid, refunded) in taken {
        let room = paid - refunded;
        match kind {
            Kind::Credit => left.credit += room,
            Kind::Loyalty => left.loyalty += room,
            Kind::StoredValue => left.stored += room,
            _ => left.money += room,
        }
    }
    left
}

/// Checks the refunds of a return worth `total` (all positive amounts): they add up to the
/// total; what the customer still owes on the original is cancelled first (refunded to Credit);
/// and no class pays back more than it took in, so points or an unpaid balance never come back
/// as cash.
pub fn check_refunds(total: Decimal, refunds: &[Tender], left: &Refundable) -> Result<(), String> {
    if refunds.iter().any(|t| t.amount <= Decimal::ZERO) {
        return Err("refunds are entered as negative amounts on a return".into());
    }
    let sum = |f: &dyn Fn(Kind) -> bool| -> Decimal { refunds.iter().filter(|t| f(t.kind)).map(|t| t.amount).sum() };
    let all = sum(&|_| true);
    if all != total {
        return Err(format!("refunds of {} must equal the return total of {}", all.normalize(), total.normalize()));
    }
    let due = total.min(left.credit);
    let credit = sum(&|k| k == Kind::Credit);
    if credit != due {
        return Err(if due.is_zero() {
            "the original sale was paid in full: refund through cash or another payment method, not Credit".into()
        } else {
            format!("{} of this refund must go to Credit: the customer still owes that much on the original sale", due.normalize())
        });
    }
    let loyalty = sum(&|k| k == Kind::Loyalty);
    if loyalty > left.loyalty {
        return Err(format!("at most {} can go back as loyalty points", left.loyalty.normalize()));
    }
    let money = sum(&|k| k.is_money());
    if money > left.money {
        return Err(format!("at most {} can be refunded in cash or to cards: that is what the original sale was paid with", left.money.normalize()));
    }
    // Money may go back as stored value (store credit); stored value never comes back as money.
    let stored = sum(&|k| k == Kind::StoredValue);
    if money + stored > left.money + left.stored {
        return Err(format!("at most {} can go back onto stored value", (left.money + left.stored - money).normalize()));
    }
    Ok(())
}

/// Points for `eligible` spend at one point per `factor` spent, rounded down.
pub fn points_earned(eligible: Decimal, factor: Decimal) -> i64 {
    if eligible <= Decimal::ZERO || factor <= Decimal::ZERO {
        return 0;
    }
    (eligible / factor).floor().to_i64().unwrap_or(0)
}

/// The collection factor of the highest tier `spent` reaches (`tiers`: minimum spend, factor).
pub fn tier_factor(spent: Decimal, tiers: &[(Decimal, Decimal)]) -> Option<Decimal> {
    tiers.iter().filter(|(min, _)| *min <= spent).max_by(|a, b| a.0.cmp(&b.0)).map(|t| t.1)
}

/// Points to take back from a sale that earned `earned` on `eligible` spend, once its returns
/// total `returned` (cumulative): proportional and rounded down, except that returning
/// everything takes back exactly what was earned, however many partial returns it took.
pub fn points_to_reverse(earned: i64, eligible: Decimal, returned: Decimal, already: i64) -> i64 {
    if earned <= 0 || eligible <= Decimal::ZERO {
        return 0;
    }
    let due = if returned >= eligible { earned } else { (Decimal::from(earned) * returned / eligible).floor().to_i64().unwrap_or(0) };
    (due - already).max(0)
}

/// The money value of `points`.
pub fn points_value(points: i64, factor: Decimal, precision: u32) -> Decimal {
    ferrum_domain::util::round(Decimal::from(points) * factor, precision)
}

/// Total of a cash count: denomination × count.
pub fn count_cash(rows: &[(Decimal, i64)]) -> Decimal {
    rows.iter().map(|(d, n)| *d * Decimal::from(*n)).sum()
}

/// Consolidated invoice lines for `qty` units whose net amounts add up to `net`, as
/// `(qty, price)`: one line at `net / qty` (9 decimals) when `round(qty × price)` gives `net`
/// back, else the last unit on a second line priced at the remainder, so the invoice always
/// totals exactly what the register sold. `strategy` is the company's rounding.
pub fn exact_lines(qty: Decimal, net: Decimal, precision: u32, strategy: RoundingStrategy) -> Vec<(Decimal, Decimal)> {
    if qty.is_zero() {
        return vec![];
    }
    let price = (net / qty).round_dp(9);
    let amount = |q: Decimal| (q * price).round_dp_with_strategy(precision, strategy);
    if qty.abs() <= Decimal::ONE || amount(qty) == net {
        return vec![(qty, price)];
    }
    let one = if qty > Decimal::ZERO { Decimal::ONE } else { -Decimal::ONE };
    let rest = qty - one;
    vec![(rest, price), (one, (net - amount(rest)) / one)]
}

/// Something a person at the till may do on their own only within their limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Act {
    Discount,
    PriceChange,
    VoidLine,
    VoidSale,
    Refund,
    ReturnWithoutReceipt,
    NoSale,
    Reprint,
}

impl Act {
    pub const ALL: [Act; 8] =
        [Act::Discount, Act::PriceChange, Act::VoidLine, Act::VoidSale, Act::Refund, Act::ReturnWithoutReceipt, Act::NoSale, Act::Reprint];

    /// Its name on records (`PosApproval.action`).
    pub fn label(self) -> &'static str {
        match self {
            Act::Discount => "Discount",
            Act::PriceChange => "Price Change",
            Act::VoidLine => "Void Line",
            Act::VoidSale => "Void Sale",
            Act::Refund => "Refund",
            Act::ReturnWithoutReceipt => "Return Without Receipt",
            Act::NoSale => "No Sale",
            Act::Reprint => "Reprint",
        }
    }

    pub fn parse(s: &str) -> Option<Act> {
        Act::ALL.into_iter().find(|a| a.label() == s)
    }
}

/// What one person may do at one register without someone else (`PosRoleLimit`): the most generous
/// of their roles. `None` caps are no cap. The till gets the same record and checks the same way.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Limits {
    /// The largest saving on a line against its list price, in percent, beyond what pricing rules gave.
    pub discount_percent: Decimal,
    /// The largest saving on a whole sale beyond what pricing rules gave.
    pub discount_amount: Option<Decimal>,
    pub change_price: bool,
    pub void_line: bool,
    pub void_sale: bool,
    /// The largest return refunded.
    pub refund: Option<Decimal>,
    pub return_without_receipt: bool,
    pub open_drawer: bool,
    pub reprint: bool,
}

/// The larger cap, where no cap is the largest.
fn wider(a: Option<Decimal>, b: Option<Decimal>) -> Option<Decimal> {
    Some(a?.max(b?))
}

impl Limits {
    /// No limit at all (a POS manager with no limits record).
    pub fn unlimited() -> Limits {
        Limits {
            discount_percent: Decimal::ONE_HUNDRED,
            discount_amount: None,
            change_price: true,
            void_line: true,
            void_sale: true,
            refund: None,
            return_without_receipt: true,
            open_drawer: true,
            reprint: true,
        }
    }

    /// The most generous of several roles' limits.
    pub fn widest(all: impl IntoIterator<Item = Limits>) -> Option<Limits> {
        all.into_iter().reduce(|a, b| Limits {
            discount_percent: a.discount_percent.max(b.discount_percent),
            discount_amount: wider(a.discount_amount, b.discount_amount),
            change_price: a.change_price || b.change_price,
            void_line: a.void_line || b.void_line,
            void_sale: a.void_sale || b.void_sale,
            refund: wider(a.refund, b.refund),
            return_without_receipt: a.return_without_receipt || b.return_without_receipt,
            open_drawer: a.open_drawer || b.open_drawer,
            reprint: a.reprint || b.reprint,
        })
    }

    /// Whether these limits let `act` through at `figure` (a saving percent or amount, a refund).
    pub fn allows(&self, act: Act, figure: Decimal) -> bool {
        match act {
            Act::Discount => figure <= self.discount_percent,
            Act::PriceChange => self.change_price,
            Act::VoidLine => self.void_line,
            Act::VoidSale => self.void_sale,
            Act::Refund => self.refund.is_none_or(|r| figure <= r),
            Act::ReturnWithoutReceipt => self.return_without_receipt,
            Act::NoSale => self.open_drawer,
            Act::Reprint => self.reprint,
        }
    }
}

/// A sale line as typed: the list price and pricing-rule discount the engine found, the price and
/// discount the cashier asked for (`None`: not typed).
#[derive(Debug, Clone, Copy)]
pub struct LineAsk {
    pub qty: Decimal,
    pub list: Decimal,
    pub rule: Decimal,
    pub price: Option<Decimal>,
    pub discount: Option<Decimal>,
}

/// What a sale asks beyond someone's limits: `(line, act, figure, why)`, the line `None` for the
/// whole sale. `header` is the sale's own discount percent. A typed price, a line discount and the
/// sale's discount count together as the saving against the list price.
pub fn beyond(limits: &Limits, lines: &[LineAsk], header: Decimal) -> Vec<(Option<usize>, Act, Decimal, String)> {
    let hundred = Decimal::ONE_HUNDRED;
    let mut out = Vec::new();
    let mut given = Decimal::ZERO;
    for (i, l) in lines.iter().enumerate() {
        let price = l.price.unwrap_or(l.list);
        let discount = l.discount.unwrap_or(l.rule);
        if l.price.is_some_and(|p| p != l.list) && !limits.change_price {
            out.push((Some(i), Act::PriceChange, Decimal::ZERO, "you may not change prices".to_string()));
        }
        if l.list <= Decimal::ZERO {
            continue;
        }
        let pays = price / l.list * (hundred - discount) / hundred * (hundred - header) / hundred;
        let saving = ((Decimal::ONE - pays) * hundred).round_dp(4);
        let allowed = l.rule.max(limits.discount_percent);
        if saving > allowed {
            out.push((Some(i), Act::Discount, saving, format!("a {}% discount exceeds the {}% allowed", saving.normalize(), allowed.normalize())));
        }
        // What the cashier gave beyond the pricing rules, in money.
        let by_rule = l.qty * l.list * (hundred - l.rule) / hundred;
        given += (by_rule - l.qty * l.list * pays).max(Decimal::ZERO);
    }
    let given = given.round_dp(2);
    if let Some(cap) = limits.discount_amount.filter(|c| given > *c) {
        out.push((None, Act::Discount, given, format!("discounts of {} on this sale exceed the {} allowed", given.normalize(), cap.normalize())));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    fn cashier() -> Limits {
        Limits {
            discount_percent: n("10"),
            discount_amount: Some(n("50")),
            change_price: false,
            void_line: true,
            void_sale: false,
            refund: Some(n("200")),
            return_without_receipt: false,
            open_drawer: false,
            reprint: true,
        }
    }

    #[test]
    fn limits_of_several_roles_take_the_most_generous() {
        let senior = Limits { discount_percent: n("20"), discount_amount: None, refund: Some(n("100")), open_drawer: true, ..cashier() };
        let both = Limits::widest([cashier(), senior]).unwrap();
        assert_eq!(both.discount_percent, n("20"));
        assert_eq!(both.discount_amount, None, "no cap is wider than any cap");
        assert_eq!(both.refund, Some(n("200")));
        assert!(both.open_drawer && !both.change_price && !both.void_sale);
        assert_eq!(Limits::widest([]), None);
        assert!(Limits::unlimited().allows(Act::Refund, n("1000000")));
        assert!(!cashier().allows(Act::Refund, n("200.01")) && cashier().allows(Act::Refund, n("200")));
        for a in Act::ALL {
            assert_eq!(Act::parse(a.label()), Some(a));
        }
    }

    #[test]
    fn what_a_sale_asks_beyond_the_limits() {
        let line = |list: &str, rule: &str, price: Option<&str>, discount: Option<&str>| LineAsk {
            qty: Decimal::ONE,
            list: n(list),
            rule: n(rule),
            price: price.map(n),
            discount: discount.map(n),
        };
        assert!(beyond(&cashier(), &[line("100", "0", None, Some("10"))], Decimal::ZERO).is_empty());
        let over = beyond(&cashier(), &[line("100", "0", None, Some("12"))], Decimal::ZERO);
        assert_eq!((over[0].0, over[0].1, over[0].2), (Some(0), Act::Discount, n("12")));
        // A pricing rule's own 15% stands; the cashier may not go beyond it.
        assert!(beyond(&cashier(), &[line("100", "15", None, None)], Decimal::ZERO).is_empty());
        // A typed price is a price change, and its saving counts with the line and sale discounts.
        let typed = beyond(&cashier(), &[line("100", "0", Some("95"), Some("5"))], Decimal::ZERO);
        assert_eq!(typed.iter().map(|x| x.1).collect::<Vec<_>>(), vec![Act::PriceChange]);
        assert_eq!(beyond(&cashier(), &[line("100", "0", None, Some("5"))], n("6"))[0].1, Act::Discount, "5% then 6% is 10.7%");
        // 10% on six lines of 100 is 60 given, over the 50 a sale may carry.
        let six: Vec<LineAsk> = (0..6).map(|_| line("100", "0", None, Some("10"))).collect();
        let sale = beyond(&cashier(), &six, Decimal::ZERO);
        assert_eq!((sale.len(), sale[0].0, sale[0].2), (1, None, n("60")));
        assert!(beyond(&Limits::unlimited(), &six, n("50")).is_empty());
    }

    fn n(s: &str) -> Decimal {
        Decimal::from_str(s).unwrap()
    }
    fn t(kind: Kind, amount: &str) -> Tender {
        Tender { kind, amount: n(amount) }
    }

    #[test]
    fn split_cash_and_card_with_change() {
        let s = settle_sale(n("92.50"), &[t(Kind::Bank, "50"), t(Kind::Cash, "50")], Decimal::ZERO).unwrap();
        assert_eq!(s, Settlement { paid: n("100"), change: n("7.50"), write_off: Decimal::ZERO });
    }

    #[test]
    fn insufficient_payment_and_write_off() {
        assert!(settle_sale(n("100"), &[t(Kind::Cash, "90")], n("1")).unwrap_err().contains("insufficient"));
        let s = settle_sale(n("100.03"), &[t(Kind::Cash, "100")], n("0.05")).unwrap();
        assert_eq!((s.change, s.write_off), (Decimal::ZERO, n("0.03")));
        assert_eq!(settle_sale(Decimal::ZERO, &[], Decimal::ZERO).unwrap(), Settlement::default(), "a free sale needs no payment");
    }

    #[test]
    fn only_cash_gives_change() {
        assert!(settle_sale(n("80"), &[t(Kind::Bank, "100")], Decimal::ZERO).unwrap_err().contains("only cash"));
        assert!(settle_sale(n("80"), &[t(Kind::Bank, "60"), t(Kind::Loyalty, "30")], Decimal::ZERO).is_err());
        let s = settle_sale(n("80"), &[t(Kind::Bank, "60"), t(Kind::Cash, "50")], Decimal::ZERO).unwrap();
        assert_eq!(s.change, n("30"), "change comes out of the 50 cash");
        let mut tenders = [t(Kind::Bank, "60"), t(Kind::Cash, "20"), t(Kind::Cash, "30")];
        net_of_change(s.change, &mut tenders);
        assert_eq!(tenders.map(|t| t.amount), [n("60"), Decimal::ZERO, n("20")], "the drawer keeps 20 of the 50 tendered");
        let mut refund = [t(Kind::Cash, "-110")];
        net_of_change(Decimal::ZERO, &mut refund);
        assert_eq!(refund[0].amount, n("-110"), "a refund gives no change");
        assert!(settle_sale(n("10"), &[t(Kind::Cash, "-5"), t(Kind::Cash, "15")], Decimal::ZERO).is_err());
    }

    #[test]
    fn refunds_follow_the_original_payment() {
        let paid_cash = Refundable { money: n("100"), ..Default::default() };
        assert!(check_refunds(n("40"), &[t(Kind::Cash, "40")], &paid_cash).is_ok());
        assert!(check_refunds(n("40"), &[t(Kind::Cash, "30")], &paid_cash).unwrap_err().contains("must equal"));
        assert!(check_refunds(n("40"), &[t(Kind::Credit, "40")], &paid_cash).unwrap_err().contains("paid in full"));
        let points = Refundable { money: n("50"), loyalty: n("50"), ..Default::default() };
        assert!(check_refunds(n("100"), &[t(Kind::Cash, "100")], &points).unwrap_err().contains("at most 50"), "points never come back as cash");
        assert!(check_refunds(n("100"), &[t(Kind::Cash, "50"), t(Kind::Loyalty, "50")], &points).is_ok());
        let on_credit = Refundable { money: n("60"), credit: n("40"), ..Default::default() };
        assert!(check_refunds(n("50"), &[t(Kind::Cash, "50")], &on_credit).unwrap_err().contains("40 of this refund must go to Credit"));
        assert!(check_refunds(n("50"), &[t(Kind::Credit, "40"), t(Kind::Cash, "10")], &on_credit).is_ok());
        assert!(check_refunds(n("30"), &[t(Kind::Credit, "30")], &on_credit).is_ok());
        // A gift card's part comes back onto stored value only; cash may go back as store credit.
        let card = refundable(&[(Kind::StoredValue, n("70"), Decimal::ZERO), (Kind::Cash, n("30"), Decimal::ZERO)], Decimal::ZERO);
        assert_eq!((card.money, card.stored), (n("30"), n("70")));
        assert!(check_refunds(n("100"), &[t(Kind::Cash, "100")], &card).unwrap_err().contains("at most 30"));
        assert!(check_refunds(n("100"), &[t(Kind::Cash, "30"), t(Kind::StoredValue, "70")], &card).is_ok());
        assert!(check_refunds(n("100"), &[t(Kind::StoredValue, "100")], &card).is_ok(), "the cash part as store credit");
        assert!(settle_sale(n("80"), &[t(Kind::StoredValue, "100")], Decimal::ZERO).unwrap_err().contains("only cash"), "a card gives no change");
    }

    #[test]
    fn what_a_sale_can_still_refund() {
        // Paid 50 by card and 60 in cash for a 92.50 bill (17.50 change): 92.50 came in.
        let mut paid = [t(Kind::Bank, "50"), t(Kind::Cash, "60")];
        net_of_change(n("17.50"), &mut paid);
        let taken: Vec<_> = paid.iter().map(|p| (p.kind, p.amount, Decimal::ZERO)).collect();
        assert_eq!(refundable(&taken, Decimal::ZERO), Refundable { money: n("92.50"), ..Default::default() });
        // An earlier return gave 20 back in cash; points and what is owed stay apart from money.
        let mixed = [(Kind::Cash, n("9"), n("2")), (Kind::Loyalty, n("2"), Decimal::ZERO), (Kind::Credit, n("40"), n("15"))];
        assert_eq!(refundable(&mixed, Decimal::ZERO), Refundable { money: n("7"), loyalty: n("2"), credit: n("25"), ..Default::default() });
        // Refunding cash for a card sale uses the same room: the card's 100 less the 100 handed back.
        assert_eq!(refundable(&[(Kind::Bank, n("100"), Decimal::ZERO), (Kind::Cash, Decimal::ZERO, n("100"))], Decimal::ZERO).money, Decimal::ZERO);
        // A bill written off by 0.05 (10.95 paid of 11.00) comes back whole.
        let short = refundable(&[(Kind::Cash, n("10.95"), Decimal::ZERO)], n("0.05"));
        assert!(check_refunds(n("11.00"), &[t(Kind::Cash, "11.00")], &short).is_ok());
        assert!(check_refunds(n("11.00"), &[t(Kind::Cash, "11.00")], &refundable(&[(Kind::Cash, n("10.95"), Decimal::ZERO)], Decimal::ZERO)).is_err());
    }

    #[test]
    fn loyalty_points() {
        assert_eq!(points_earned(n("999.99"), n("100")), 9);
        assert_eq!(points_earned(n("-5"), n("100")), 0);
        let tiers = [(Decimal::ZERO, n("100")), (n("10000"), n("50"))];
        assert_eq!(tier_factor(n("9999.99"), &tiers), Some(n("100")));
        assert_eq!(tier_factor(n("10000"), &tiers), Some(n("50")), "silver tier earns twice as fast");
        assert_eq!(tier_factor(n("5"), &[(n("10"), n("1"))]), None);
        assert_eq!(points_value(7, n("0.5"), 2), n("3.50"));
        // 10 points on 1000: three returns of 333.33 take 3 + 3 + 4 points back.
        let mut taken = 0;
        for (i, returned) in ["333.33", "666.66", "1000"].iter().enumerate() {
            let now = points_to_reverse(10, n("1000"), n(returned), taken);
            assert_eq!(now, [3, 3, 4][i]);
            taken += now;
        }
        assert_eq!(points_to_reverse(10, n("1000"), n("1200"), 10), 0, "never more than earned");
    }

    #[test]
    fn cash_denominations() {
        assert_eq!(count_cash(&[(n("500"), 3), (n("100"), 7), (n("0.50"), 5)]), n("2202.50"));
        assert_eq!(count_cash(&[]), Decimal::ZERO);
    }

    #[test]
    fn consolidation_lines_add_up_exactly() {
        let half_up = RoundingStrategy::MidpointAwayFromZero;
        let total = |lines: &[(Decimal, Decimal)]| -> Decimal { lines.iter().map(|(q, p)| (q * p).round_dp_with_strategy(2, half_up)).sum() };
        for (qty, net) in [("3", "10.00"), ("7", "1.00"), ("2.5", "9.99"), ("30000000", "10000000.00"), ("-3", "-10.00"), ("-30000000", "-10000000.00")] {
            let lines = exact_lines(n(qty), n(net), 2, half_up);
            assert_eq!(total(&lines), n(net), "{qty} for {net}: {lines:?}");
            assert_eq!(lines.iter().map(|l| l.0).sum::<Decimal>(), n(qty));
        }
        assert_eq!(exact_lines(n("30000000"), n("10000000.00"), 2, half_up).len(), 2, "a rounding unit would be lost on one line");
        assert_eq!(exact_lines(n("4"), n("10.00"), 2, half_up), vec![(n("4"), n("2.5"))]);
    }
}
