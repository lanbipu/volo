use mesh_core::uncertainty::Uncertainty;
use nalgebra::Matrix3;

#[test]
fn isotropic_to_covariance_diagonal() {
    let u = Uncertainty::Isotropic(2.0);
    let cov = u.covariance();
    assert_eq!(cov, Matrix3::from_diagonal_element(4.0)); // sigma^2
}

#[test]
fn isotropic_serializes_to_yaml() {
    let u = Uncertainty::Isotropic(1.5);
    let s = serde_yaml::to_string(&u).unwrap();
    assert!(s.contains("isotropic"));
    assert!(s.contains("1.5"));
}
