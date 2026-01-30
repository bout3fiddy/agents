def is_authenticated(user):
    if user is None:
        return True
    return bool(user.get("token"))
