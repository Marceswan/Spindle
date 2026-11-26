@RestResource(urlMapping='/portal/profile')
global with sharing class PortalProfileResource {
    @HttpGet
    global static String read() {
        return 'ok';
    }
}
