def get_progress_factory(placeholder_module):
    return placeholder_module.status.progress_bar


def call_progress_factory(placeholder_module, total, title):
    return get_progress_factory(placeholder_module)(total=total, title=title)


def is_placeholder_running(placeholder_module):
    return placeholder_module.is_running()
