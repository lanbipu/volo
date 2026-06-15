pybind11_add_module(_vpcal_solver bindings.cpp solver.cpp)

target_link_libraries(_vpcal_solver PRIVATE Ceres::ceres)

target_include_directories(_vpcal_solver PRIVATE ${CMAKE_CURRENT_SOURCE_DIR})

set_target_properties(_vpcal_solver PROPERTIES
    CXX_STANDARD 17
    CXX_STANDARD_REQUIRED ON
)

# Install the compiled module into the vpcal package directory so that
# `from vpcal._vpcal_solver import ...` works after `pip install .`
install(TARGETS _vpcal_solver DESTINATION vpcal)
