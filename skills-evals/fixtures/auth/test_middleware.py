from middleware import is_authenticated


def test_with_token():
    assert is_authenticated({"token": "abc"}) is True
