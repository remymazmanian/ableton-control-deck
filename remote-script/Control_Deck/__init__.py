from .Control_Deck import ControlDeckBridge


def create_instance(c_instance):
    return ControlDeckBridge(c_instance)
