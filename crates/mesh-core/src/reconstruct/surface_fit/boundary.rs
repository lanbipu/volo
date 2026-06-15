use crate::reconstruct::surface_fit::BoundaryCheck;
use crate::shape::CabinetArray;

/// 投影物理尺寸（**米**）与 cabinet 期望尺寸（mm）做一致性校验。
/// 调用方负责把圆柱弧长(R×Δθ)/平面 Δu 等换算成米传入；这里统一 ×1000 转 mm 再比。
pub fn check_boundary(projected_size_m: [f64; 2], cab: &CabinetArray) -> BoundaryCheck {
    let projected_size_mm = [projected_size_m[0] * 1000.0, projected_size_m[1] * 1000.0];
    let expected = cab.total_size_mm();
    let cab_w = cab.cabinet_size_mm[0];
    let cab_h = cab.cabinet_size_mm[1];

    let dev_w = (projected_size_mm[0] - expected[0]).abs();
    let dev_h = (projected_size_mm[1] - expected[1]).abs();
    let ok_w = cab_w.max(expected[0] * 0.02);
    let ok_h = cab_h.max(expected[1] * 0.02);
    let rej_w = (2.0 * cab_w).max(expected[0] * 0.10);
    let rej_h = (2.0 * cab_h).max(expected[1] * 0.10);

    let verdict = if dev_w > rej_w || dev_h > rej_h {
        "reject"
    } else if dev_w > ok_w || dev_h > ok_h {
        "warning"
    } else {
        "ok"
    };
    BoundaryCheck {
        verdict: verdict.to_string(),
        projected_size_mm,
        expected_size_mm: expected,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shape::CabinetArray;

    #[test]
    fn matching_size_is_ok() {
        let cab = CabinetArray::rectangle(55, 15, [500.0, 500.0]);
        let c = check_boundary([27.48, 7.50], &cab);
        assert_eq!(c.verdict, "ok");
    }

    #[test]
    fn far_off_size_is_reject() {
        let cab = CabinetArray::rectangle(55, 15, [500.0, 500.0]);
        let c = check_boundary([13.0, 7.50], &cab);
        assert_eq!(c.verdict, "reject");
    }

    #[test]
    fn unit_conversion_does_not_falsely_reject_metric_screen() {
        let cab = CabinetArray::rectangle(8, 4, [500.0, 500.0]); // 期望 4000×2000 mm
        let c = check_boundary([4.0, 2.0], &cab);
        assert_eq!(c.verdict, "ok");
    }
}
