({
    handleCleanup: function (component, event, helper) {
        var action = component.get("c.cleanup");
        action.setCallback(this, function (response) {
            if (response.getState() === "SUCCESS") {
                helper.refresh(component);
            }
        });
        $A.enqueueAction(action);
    }
})
