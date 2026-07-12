def test_package_imports_and_reports_version():
    import code_index

    assert isinstance(code_index.__version__, str)
    assert code_index.__version__ != ""
