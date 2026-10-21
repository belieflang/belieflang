use bel_syntax::ast::{BeliefCardinality, BeliefDistribution, BeliefDomain, BeliefState};
use indexmap::IndexMap;

pub const EPSILON: f64 = 1e-9;

#[derive(Debug, Clone, PartialEq)]
pub struct BeliefMeta {
    pub cardinality: BeliefCardinality,
    pub domain: BeliefDomain,
    pub open_mass: f64,
}

#[derive(Debug, Clone)]
pub struct NormalizedBelief {
    pub values: BeliefDistribution,
    pub open_mass: f64,
}

pub fn normalize_belief<F>(
    belief_name: &str,
    values: &BeliefDistribution,
    cardinality: BeliefCardinality,
    domain: BeliefDomain,
    clamp_multi: bool,
    mut on_trace: F,
) -> Result<NormalizedBelief, String>
where
    F: FnMut(String),
{
    if values.is_empty() {
        return Err(format!("belief {belief_name} has no values"));
    }

    if cardinality == BeliefCardinality::Multi {
        let mut normalized = IndexMap::new();

        for (label, &raw_value) in values {
            if !raw_value.is_finite() {
                return Err(format!("belief {belief_name}.{label} must be finite"));
            }

            let mut value = raw_value;
            if clamp_multi {
                value = raw_value.clamp(0.0, 1.0);
                if (value - raw_value).abs() > EPSILON {
                    on_trace(format!(
                        "clamped {belief_name}.{label} from {:.3} to {:.3}",
                        raw_value, value
                    ));
                }
            } else if value < 0.0 || value > 1.0 + EPSILON {
                return Err(format!(
                    "belief {belief_name}.{label} must be in [0, 1] for multi beliefs"
                ));
            }

            normalized.insert(label.clone(), value);
        }

        return Ok(NormalizedBelief {
            values: normalized,
            open_mass: 0.0,
        });
    }

    for (label, &value) in values {
        if !value.is_finite() || value < 0.0 {
            return Err(format!(
                "belief {belief_name}.{label} must be a non-negative number"
            ));
        }
    }

    let total: f64 = values.values().sum();
    if total <= 0.0 {
        return Err(format!(
            "belief {belief_name} has non-positive probability mass"
        ));
    }

    if domain == BeliefDomain::Closed {
        let mut normalized = IndexMap::new();
        for (label, &value) in values {
            normalized.insert(label.clone(), value / total);
        }
        return Ok(NormalizedBelief {
            values: normalized,
            open_mass: 0.0,
        });
    }

    if total > 1.0 + EPSILON {
        return Err(format!(
            "belief {belief_name} is open+exclusive and cannot exceed total mass 1.0"
        ));
    }

    let open_mass = (1.0 - total).max(0.0);
    Ok(NormalizedBelief {
        values: values.clone(),
        open_mass,
    })
}

pub fn confidence(
    state: &BeliefState,
    meta_map: &IndexMap<String, BeliefMeta>,
    path: &str,
) -> Result<f64, String> {
    let parts: Vec<&str> = path.split('.').collect();
    if parts.len() != 2 || parts[0].is_empty() || parts[1].is_empty() {
        return Err(format!("confidence() expects name.key, got {path}"));
    }

    let belief_name = parts[0];
    let key = parts[1];

    let belief = match state.get(belief_name) {
        Some(b) => b,
        None => return Ok(0.0),
    };

    if let Some(&val) = belief.get(key) {
        return Ok(val);
    }

    if let Some(meta) = meta_map.get(belief_name) {
        if meta.cardinality == BeliefCardinality::Exclusive
            && meta.domain == BeliefDomain::Open
            && key == "other"
        {
            return Ok(meta.open_mass);
        }
    }

    Ok(0.0)
}

pub fn entropy(
    state: &BeliefState,
    meta_map: &IndexMap<String, BeliefMeta>,
    belief_name: &str,
) -> Result<f64, String> {
    let belief = state
        .get(belief_name)
        .ok_or_else(|| format!("unknown belief {belief_name}"))?;
    let meta = meta_map
        .get(belief_name)
        .ok_or_else(|| format!("unknown belief {belief_name}"))?;

    if meta.cardinality == BeliefCardinality::Exclusive {
        let mut probs: Vec<f64> = belief.values().copied().filter(|&p| p > 0.0).collect();

        if meta.domain == BeliefDomain::Open && meta.open_mass > 0.0 {
            probs.push(meta.open_mass);
        }

        if probs.len() <= 1 {
            return Ok(0.0);
        }

        let raw: f64 = -probs.iter().map(|&p| p * p.log2()).sum::<f64>();
        let max_entropy = (probs.len() as f64).log2();
        return Ok(raw / max_entropy);
    }

    let probs: Vec<f64> = belief.values().copied().collect();
    if probs.is_empty() {
        return Ok(0.0);
    }

    let sum_entropy: f64 = probs.iter().map(|&p| binary_entropy(p)).sum();
    Ok(sum_entropy / probs.len() as f64)
}

fn binary_entropy(p: f64) -> f64 {
    if p <= 0.0 || p >= 1.0 {
        0.0
    } else {
        -p * p.log2() - (1.0 - p) * (1.0 - p).log2()
    }
}
