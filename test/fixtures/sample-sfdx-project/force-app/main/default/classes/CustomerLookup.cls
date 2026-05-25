public with sharing class CustomerLookup {
    public static List<Customer__c> findGoldCustomers() {
        return [SELECT Id, Name, Email__c, Tier__c FROM Customer__c WHERE Tier__c = 'Gold'];
    }
}
