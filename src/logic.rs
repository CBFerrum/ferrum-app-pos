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
}

impl Kind {
    pub fn parse(s: &str) -> Option<Kind> {
        Some(match s {
            "Cash" => Kind::Cash,
            "Bank" => Kind::Bank,
            "General" => Kind::General,
            "Credit" => Kind::Credit,
            "Loyalty Points" => Kind::Loyalty,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

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
        let points = Refundable { money: n("50"), loyalty: n("50"), credit: Decimal::ZERO };
        assert!(check_refunds(n("100"), &[t(Kind::Cash, "100")], &points).unwrap_err().contains("at most 50"), "points never come back as cash");
        assert!(check_refunds(n("100"), &[t(Kind::Cash, "50"), t(Kind::Loyalty, "50")], &points).is_ok());
        let on_credit = Refundable { money: n("60"), credit: n("40"), loyalty: Decimal::ZERO };
        assert!(check_refunds(n("50"), &[t(Kind::Cash, "50")], &on_credit).unwrap_err().contains("40 of this refund must go to Credit"));
        assert!(check_refunds(n("50"), &[t(Kind::Credit, "40"), t(Kind::Cash, "10")], &on_credit).is_ok());
        assert!(check_refunds(n("30"), &[t(Kind::Credit, "30")], &on_credit).is_ok());
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
